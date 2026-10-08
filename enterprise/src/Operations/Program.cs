using System.Text.Json;
using DriveCore;
using Npgsql;

var builder=Hosting.Create(args,"operations");
Hosting.Database(builder);
if(Hosting.IsMigration(args))
{
    await using var source=NpgsqlDataSource.Create(Hosting.Required(builder.Configuration,"Database:Connection"));
    await OperationsSchema.Apply(source);return;
}
builder.Services.AddSingleton<DriveCore.EventHandler,OperationsEvents>();
Messaging.Add(builder,"operations","HubRegistered","InventoryUpdated","OrderCompleted","OrderReconciliationRequired");
var app=builder.Build();
Hosting.Configure(app);
app.MapGet("/national",async(HttpContext context,Store store,CancellationToken ct)=>
{
    var actor=Hosting.Actor(context);actor.Demand("Regional Manager","Hub Manager","Hub Owner","Product Owner","Corporate Administrator");
    return await store.Transaction(async unit=>
    {
        var hubs=new List<HubScore>();
        var now=DateTime.UtcNow.Date;
        var monday=now.AddDays(-((int)now.DayOfWeek+6)%7);
        await using(var command=unit.Sql("""
            SELECT a.id,a.body::text,COALESCE(s.available,0),COALESCE(s.low,0),COALESCE(s.positions,0),COALESCE(s.orders,0),s.last_event
            FROM aggregates a LEFT JOIN hub_scores s ON s.tenant=a.tenant AND s.hub=a.id
            WHERE a.tenant=@tenant AND a.kind='hub' ORDER BY a.id LIMIT 1000
            """,("tenant",actor.Tenant)))
        await using(var reader=await command.ExecuteReaderAsync(ct))
        {
            while(await reader.ReadAsync(ct))
            {
                var hub=Json.Read<HubRegistered>(reader.GetString(1));
                if(!actor.Corporate&&!actor.Hubs.Contains(hub.HubId.ToString()))continue;
                hubs.Add(new(hub.HubId,hub.Name,hub.Region,hub.Kind,hub.Status,hub.Bays,hub.Latitude,hub.Longitude,
                    reader.GetInt64(2),reader.GetInt64(3),reader.GetInt64(4),reader.GetInt64(5),[],
                    reader.IsDBNull(6)?null:new DateTimeOffset(reader.GetDateTime(6))));
            }
        }
        await using(var command=unit.Sql("""
            SELECT hub,currency,
              COALESCE(SUM(amount) FILTER(WHERE day=@today),0)::bigint,
              COALESCE(SUM(amount) FILTER(WHERE day>=@week),0)::bigint,
              COALESCE(SUM(amount) FILTER(WHERE day>=@month),0)::bigint,
              COALESCE(SUM(amount),0)::bigint
            FROM daily_revenue WHERE tenant=@tenant AND day>=@year AND day<=@today GROUP BY hub,currency
            """,("tenant",actor.Tenant),("today",DateOnly.FromDateTime(now)),("week",DateOnly.FromDateTime(monday)),
            ("month",new DateOnly(now.Year,now.Month,1)),("year",new DateOnly(now.Year,1,1))))
        await using(var reader=await command.ExecuteReaderAsync(ct))
        {
            while(await reader.ReadAsync(ct))
            {
                var index=hubs.FindIndex(h=>h.Id==reader.GetGuid(0));if(index<0)continue;
                var revenue=new RevenueTotal(reader.GetString(1),reader.GetInt64(2),reader.GetInt64(3),reader.GetInt64(4),reader.GetInt64(5));
                hubs[index]=hubs[index] with{Revenue=[..hubs[index].Revenue,revenue]};
            }
        }
        long dead=0,pending=0,outbox=0;
        if(actor.Corporate)
        {
            await using var command=unit.Sql("""
                SELECT
                (SELECT COUNT(*) FROM inbox WHERE payload->>'tenantId'=@tenant AND processed IS NULL AND attempts>=10),
                (SELECT COUNT(*) FROM inbox WHERE payload->>'tenantId'=@tenant AND processed IS NULL AND attempts<10),
                (SELECT COUNT(*) FROM outbox WHERE payload->>'tenantId'=@tenant AND delivered IS NULL)
                """,("tenant",actor.Tenant.ToString()));
            await using var reader=await command.ExecuteReaderAsync(ct);
            if(await reader.ReadAsync(ct)){dead=reader.GetInt64(0);pending=reader.GetInt64(1);outbox=reader.GetInt64(2);}
        }
        return new NationalSnapshot(DateTimeOffset.UtcNow,"Eventual; last-event timestamps show projection freshness",
            "Hub registry, physical inventory and completed merchandise sales only. Service, attendance, satisfaction and AI not yet connected.",hubs.ToArray(),dead,pending,outbox);
    },ct);
}).RequireAuthorization();
await app.RunAsync();

public sealed class OperationsEvents:DriveCore.EventHandler
{
    public async Task Handle(UnitOfWork unit,DomainEvent message)
    {
        if(message.Type=="OrderReconciliationRequired")
        {
            var previous=await unit.Get<JsonElement>("reconciliation",message.TenantId,message.AggregateId);
            await unit.Save("reconciliation",message.TenantId,message.AggregateId,message.Data,previous?.Version??0);
        }
        else if(message.Type=="HubRegistered")
        {
            var revision=await unit.Get<long>("hub-revision",message.TenantId,message.AggregateId);
            if(revision is not null&&revision.Data>=message.AggregateVersion)return;
            var previous=await unit.Get<JsonElement>("hub",message.TenantId,message.AggregateId);
            await unit.Save("hub",message.TenantId,message.AggregateId,message.Data,previous?.Version??0);
            await unit.Save("hub-revision",message.TenantId,message.AggregateId,message.AggregateVersion,revision?.Version??0);
            await unit.Run("INSERT INTO hub_scores(tenant,hub,last_event) VALUES(@tenant,@hub,@time) ON CONFLICT(tenant,hub) DO UPDATE SET last_event=GREATEST(hub_scores.last_event,@time)",
                ("tenant",message.TenantId),("hub",message.AggregateId),("time",message.OccurredAt));
        }
        else if(message.Type=="InventoryUpdated")
        {
            var s=message.Data.Deserialize<StockChanged>(Json.Options)??throw new InvalidOperationException("Invalid stock event.");
            long previousAvailable=0,previousLow=0,previousCount=0;
            await using(var command=unit.Sql("SELECT on_hand,reserved,safety,version FROM stock WHERE tenant=@tenant AND hub=@hub AND product=@product FOR UPDATE",
                ("tenant",message.TenantId),("hub",s.HubId),("product",s.ProductId)))
            await using(var r=await command.ExecuteReaderAsync())
            {
                if(await r.ReadAsync())
                {
                    if(r.GetInt64(3)>=message.AggregateVersion)return;
                    previousAvailable=r.GetInt64(0)-r.GetInt64(1);previousLow=previousAvailable<=r.GetInt64(2)?1:0;previousCount=1;
                }
            }
            await unit.Run("""
                INSERT INTO stock(tenant,hub,product,on_hand,reserved,quarantine,safety,version) VALUES(@tenant,@hub,@product,@hand,@reserved,@quarantine,@safety,@version)
                ON CONFLICT(tenant,hub,product) DO UPDATE SET on_hand=@hand,reserved=@reserved,quarantine=@quarantine,safety=@safety,version=@version
                """,("tenant",message.TenantId),("hub",s.HubId),("product",s.ProductId),("hand",s.OnHand),("reserved",s.Reserved),
                ("quarantine",s.Quarantine),("safety",s.SafetyStock),("version",message.AggregateVersion));
            var available=s.OnHand-s.Reserved;
            await unit.Run("""
                INSERT INTO hub_scores(tenant,hub,available,low,positions,last_event) VALUES(@tenant,@hub,@available,@low,@count,@time)
                ON CONFLICT(tenant,hub) DO UPDATE SET available=hub_scores.available+@available,low=hub_scores.low+@low,
                  positions=hub_scores.positions+@count,last_event=GREATEST(hub_scores.last_event,@time)
                """,("tenant",message.TenantId),("hub",s.HubId),("available",available-previousAvailable),
                ("low",(available<=s.SafetyStock?1:0)-previousLow),("count",1-previousCount),("time",message.OccurredAt));
        }
        else if(message.Type=="OrderCompleted")
        {
            var o=message.Data.Deserialize<OrderFinalized>(Json.Options)??throw new InvalidOperationException("Invalid completed order.");
            if(await unit.Run("INSERT INTO order_facts VALUES(@tenant,@id) ON CONFLICT DO NOTHING",("tenant",message.TenantId),("id",o.OrderId))==0)return;
            await unit.Run("""
                INSERT INTO daily_revenue VALUES(@tenant,@hub,@day,@currency,@total) ON CONFLICT(tenant,hub,day,currency)
                  DO UPDATE SET amount=daily_revenue.amount+@total
                """,("tenant",message.TenantId),("hub",o.HubId),("day",DateOnly.FromDateTime(message.OccurredAt.UtcDateTime)),("currency",o.Currency),("total",o.Total));
            await unit.Run("""
                INSERT INTO hub_scores(tenant,hub,orders,last_event) VALUES(@tenant,@hub,1,@time) ON CONFLICT(tenant,hub)
                  DO UPDATE SET orders=hub_scores.orders+1,last_event=GREATEST(hub_scores.last_event,@time)
                """,("tenant",message.TenantId),("hub",o.HubId),("time",message.OccurredAt));
        }
    }
}
