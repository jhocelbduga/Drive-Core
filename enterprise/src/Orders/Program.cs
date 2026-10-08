using System.Net.Http.Headers;
using System.Text.Json;
using DriveCore;
using DriveCore.Orders;
using Npgsql;

var builder=Hosting.Create(args,"orders");
Hosting.Database(builder);
if(Hosting.IsMigration(args))
{
    await using var source=NpgsqlDataSource.Create(Hosting.Required(builder.Configuration,"Database:Connection"));
    await Migrations.Apply(source); return;
}
builder.Services.AddSingleton<DriveCore.EventHandler,OrderEvents>();
builder.Services.AddHostedService<OrderExpiry>();
Messaging.Add(builder,"orders","InventoryReserved","InventoryReservationRejected","InventoryCommitted","InventoryCommitRejected","InventoryReservationReleased");
var app=builder.Build();
Hosting.Configure(app);
app.MapGet("/orders",async(HttpContext context,Store store,int? offset,CancellationToken ct)=>
{
    var actor=Hosting.Actor(context);
    return await store.Transaction(u=>u.ListScoped<Order>("order",actor,false,OrderRules.Staff(actor),100,
        (int)Rules.Amount(offset??0,"Offset",0,10_000_000)),ct);
}).RequireAuthorization();
app.MapGet("/orders/{id:guid}",async(Guid id,HttpContext context,Store store,CancellationToken ct)=>
{
    var actor=Hosting.Actor(context);
    var order=await store.Transaction(async u=>await u.Get<Order>("order",actor.Tenant,id)??throw new RuleViolation("Order not found.",404),ct);
    if(!OrderRules.Visible(actor,order.Data)) throw new RuleViolation("Order access denied.",403);
    return order;
}).RequireAuthorization();
app.MapPost("/orders",async(CreateOrder input,HttpContext context,Store store,IHttpClientFactory clients,IConfiguration config,CancellationToken ct)=>
{
    var actor=Hosting.Actor(context);actor.Demand("Sales Clerk","Hub Manager","Customer");actor.Hub(input.HubId);
    if(input.Id==Guid.Empty || input.Lines is null || input.Lines.Length is <1 or >50) throw new RuleViolation("Order UUID and 1-50 lines are required.");
    return await store.Command(actor,Hosting.Key(context),input,async unit=>
    {
        var client=clients.CreateClient("domains");
        using var request=new HttpRequestMessage(HttpMethod.Post,Hosting.Required(config,"Domains:Catalog")+"/quotes")
        { Content=JsonContent.Create(new{input.HubId,input.Lines},options:Json.Options) };
        request.Headers.Authorization=AuthenticationHeaderValue.Parse(context.Request.Headers.Authorization.ToString());
        using var response=await client.SendAsync(request,ct);
        if(!response.IsSuccessStatusCode) throw new RuleViolation("Catalogue quote unavailable or rejected; no order was created.",(int)response.StatusCode>=500?503:409);
        var quote=await response.Content.ReadFromJsonAsync<QuoteResult>(Json.Options,ct)??throw new InvalidOperationException("Invalid catalogue reply.");
        var order=new Order(input.Id,input.HubId,actor.Subject,quote.Lines,quote.Total,quote.Currency,"PendingReservation",DateTimeOffset.UtcNow,DateTimeOffset.UtcNow.AddMinutes(5));
        var version=await unit.Save("order",actor.Tenant,input.Id,order,0);
        await unit.Emit(DomainEvent.New("OrderCreated",actor.Tenant,input.HubId,input.Id,version,
            new OrderRequested(input.Id,input.HubId,actor.Subject,quote.Lines,quote.Total,quote.Currency)));
        await unit.Audit(actor,"OrderCreated",input.Id,input.HubId);
        return new Stored<Order>(input.Id,order,version);
    },ct);
}).RequireAuthorization();
app.MapPost("/orders/{id:guid}/settle",async(Guid id,Settlement input,HttpContext context,Store store,CancellationToken ct)=>
{
    var actor=Hosting.Actor(context);actor.Demand("Cashier","Hub Manager");
    if(!input.VerifiedExternal || input.Method is not ("Cash" or "Debit Card" or "Credit Card" or "E-Wallet" or "Bank Transfer"))
        throw new RuleViolation("Verify the external settlement and supply a supported method. This endpoint does not charge payments.");
    return await store.Command(actor,Hosting.Key(context),new{id,input},async unit=>
    {
        await unit.Lock($"{actor.Tenant}:orders:events");
        var old=await unit.Get<Order>("order",actor.Tenant,id)??throw new RuleViolation("Order not found.",404);actor.Hub(old.Data.HubId);
        Rules.Version(old.Version,input.Version);
        if(old.Data.Total!=input.Amount || old.Data.Currency!=input.Currency) throw new RuleViolation("Settlement amount/currency must equal the quote.");
        var next=OrderRules.Settle(old.Data,input.Reference);
        var version=await unit.Save("order",actor.Tenant,id,next,old.Version);
        await unit.Emit(DomainEvent.New("ReservationCommitRequested",actor.Tenant,next.HubId,id,version,new ReservationResult(id,next.HubId)));
        await unit.Audit(actor,"ExternalSettlementRecorded",id,next.HubId);
        return new Stored<Order>(id,next,version);
    },ct);
}).RequireAuthorization();
app.MapPost("/orders/{id:guid}/cancel",async(Guid id,Cancel input,HttpContext context,Store store,CancellationToken ct)=>
{
    var actor=Hosting.Actor(context);actor.Demand("Sales Clerk","Hub Manager","Customer");
    return await store.Command(actor,Hosting.Key(context),new{id,input},async unit=>
    {
        await unit.Lock($"{actor.Tenant}:orders:events");
        var old=await unit.Get<Order>("order",actor.Tenant,id)??throw new RuleViolation("Order not found.",404);
        if(!OrderRules.Visible(actor,old.Data))throw new RuleViolation("Order access denied.",403);
        Rules.Version(old.Version,input.Version);
        var next=OrderRules.Cancel(old.Data);
        var version=await unit.Save("order",actor.Tenant,id,next,old.Version);
        await unit.Emit(DomainEvent.New("ReservationReleaseRequested",actor.Tenant,next.HubId,id,version,new ReservationResult(id,next.HubId)));
        await unit.Audit(actor,"OrderCancelled",id,next.HubId);
        return new Stored<Order>(id,next,version);
    },ct);
}).RequireAuthorization();
await app.RunAsync();

public sealed record CreateOrder(Guid Id,Guid HubId,RequestedLine[] Lines);
public sealed record QuoteResult(QuotedLine[] Lines,long Total,string Currency);
public sealed record Settlement(long Version,long Amount,string Currency,string Method,string Reference,bool VerifiedExternal);
public sealed record Cancel(long Version);

public sealed class OrderEvents:DriveCore.EventHandler
{
    public async Task Handle(UnitOfWork unit,DomainEvent message)
    {
        var old=await unit.Get<Order>("order",message.TenantId,message.AggregateId)??throw new InvalidOperationException("Order not found for inventory event.");
        var order=old.Data;Order next;
        switch(message.Type)
        {
            case "InventoryReserved":
                if(order.Status=="Cancelled" || order.Status=="Rejected")
                {
                    await unit.Emit(DomainEvent.New("ReservationReleaseRequested",message.TenantId,order.HubId,order.Id,old.Version,new ReservationResult(order.Id,order.HubId)));
                    return;
                }
                next=OrderRules.Reserve(order);break;
            case "InventoryCommitted":
                if(order.Status=="Completed")return;
                next=OrderRules.Complete(order);break;
            case "InventoryReservationRejected":
                if(order.Status is "Completed" or "Cancelled")return;
                next=order with{Status="Rejected",Failure="Stock reservation rejected."};break;
            case "InventoryCommitRejected":
                if(order.Status!="CommittingInventory")return;
                next=order with{Status="SettlementReconciliationRequired",Failure="Inventory commit rejected. External settlement requires operator refund/reconciliation."};break;
            case "InventoryReservationReleased":
                if(order.Status is "Completed" or "Cancelled" or "Rejected")return;
                next=order with{Status=order.SettlementReference is null?"Rejected":"SettlementReconciliationRequired",Failure="Inventory reservation released or expired."};break;
            default:return;
        }
        if(next==order)return;
        var version=await unit.Save("order",message.TenantId,old.Id,next,old.Version);
        if(next.Status=="Completed")await unit.Emit(DomainEvent.New("OrderCompleted",message.TenantId,next.HubId,next.Id,version,
            new OrderFinalized(next.Id,next.HubId,next.Total,next.Currency,next.CustomerSubject)));
        else if(next.Status=="SettlementReconciliationRequired")await unit.Emit(DomainEvent.New("OrderReconciliationRequired",message.TenantId,next.HubId,next.Id,version,new ReservationResult(next.Id,next.HubId,next.Failure)));
    }
}
public sealed class OrderExpiry(Store store,NpgsqlDataSource data,ILogger<OrderExpiry> logger):BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while(!ct.IsCancellationRequested)
        {
            try
            {
                var candidates=new List<(Guid Tenant,Guid Id)>();
                await using var command=data.CreateCommand("""
                    SELECT tenant,id FROM aggregates WHERE kind='order' AND body->>'status'='PendingReservation'
                    AND (body->>'reservationDeadline')::timestamptz<=now() LIMIT 100
                    """);
                await using(var r=await command.ExecuteReaderAsync(ct))while(await r.ReadAsync(ct))candidates.Add((r.GetGuid(0),r.GetGuid(1)));
                foreach(var(tenant,id)in candidates)await store.Transaction(async unit=>
                {
                    await unit.Lock($"{tenant}:orders:events");
                    var old=await unit.Get<Order>("order",tenant,id);
                    if(old?.Data.Status!="PendingReservation")return false;
                    var next=old.Data with{Status="Rejected",Failure="Reservation timeout."};
                    var version=await unit.Save("order",tenant,id,next,old.Version);
                    await unit.Emit(DomainEvent.New("ReservationReleaseRequested",tenant,next.HubId,id,version,new ReservationResult(id,next.HubId)));
                    return true;
                },ct);
            }
            catch(Exception e)when(!ct.IsCancellationRequested){logger.LogError(e,"Order saga timeout sweep failed");}
            try{await Task.Delay(TimeSpan.FromSeconds(15),ct);}catch(OperationCanceledException)when(ct.IsCancellationRequested){break;}
        }
    }
}
