using System.Text.Json;
using DriveCore;
using DriveCore.Inventory;
using Npgsql;

var builder = Hosting.Create(args, "inventory");
Hosting.Database(builder);
if (Hosting.IsMigration(args))
{
    await using var source = NpgsqlDataSource.Create(Hosting.Required(builder.Configuration, "Database:Connection"));
    await Migrations.Apply(source); return;
}
builder.Services.AddSingleton<InventoryEngine>();
builder.Services.AddSingleton<DriveCore.EventHandler>(p => p.GetRequiredService<InventoryEngine>());
builder.Services.AddHostedService<ExpiryWorker>();
Messaging.Add(builder, "inventory", "HubRegistered", "ProductUpdated", "OrderCreated", "ReservationCommitRequested", "ReservationReleaseRequested");
var app = builder.Build();
Hosting.Configure(app);
app.MapGet("/stock/{hub:guid}", async (Guid hub, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context); actor.Hub(hub);
    return await store.Transaction(u => InventoryEngine.Positions(u, actor.Tenant, hub, null, 200), ct);
}).RequireAuthorization();
app.MapGet("/availability/{product:guid}", async (Guid product, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context);
    return await store.Transaction(u => InventoryEngine.Positions(u, actor.Tenant, null, product, 500), ct);
}).RequireAuthorization();
app.MapPost("/stock/{hub:guid}/receive", async (Guid hub, ReceiveInput input, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context); actor.Demand("Stock Custodian", "Inventory Controller", "Hub Manager"); actor.Hub(hub);
    return await store.Command(actor, Hosting.Key(context), new { hub, input }, async unit =>
    {
        var facility = await unit.Get<HubRegistered>("hub", actor.Tenant, hub);
        if (facility?.Data.Status != "Active") throw new RuleViolation("Hub not synchronized or inactive.", 409);
        var product = await unit.Get<ProductMirror>("product", actor.Tenant, input.ProductId);
        if (product?.Data.Kind is not ("Part" or "Accessory") || !product.Data.Active) throw new RuleViolation("Active physical product not synchronized.", 409);
        await unit.Lock($"{actor.Tenant}:stock:{hub}:{input.ProductId}");
        var stock = await InventoryEngine.Position(unit, actor.Tenant, hub, input.ProductId);
        Rules.Version(stock.Version, input.Version);
        var next = StockRules.Receive(stock, input.Quantity) with { SafetyStock = Rules.Amount(input.SafetyStock, "Safety stock", 0, 1_000_000) };
        var reference = Rules.Text(input.Reference, "Supplier delivery reference");
        await unit.Lock($"{actor.Tenant}:delivery:{hub}:{input.ProductId}:{reference}");
        var deliveryId = new Guid(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{hub}:{input.ProductId}:{reference}"))[..16]);
        if (await unit.Get<string>("delivery", actor.Tenant, deliveryId) is not null) throw new RuleViolation("Product/delivery reference already received.", 409);
        await unit.Save("delivery", actor.Tenant, deliveryId, reference, 0);
        await InventoryEngine.SavePosition(unit, next);
        await unit.Run("INSERT INTO stock_ledger VALUES(@id,@tenant,@hub,@product,@delta,@reason,@reference,@subject,now())",
            ("id", Guid.NewGuid()), ("tenant", actor.Tenant), ("hub", hub), ("product", input.ProductId),
            ("delta", input.Quantity), ("reason", "SupplierReceiving"), ("reference", reference), ("subject", actor.Subject));
        await unit.Audit(actor, "StockReceived", input.ProductId, hub);
        return next;
    }, ct);
}).RequireAuthorization();
await app.RunAsync();

public sealed record ReceiveInput(Guid ProductId, long Quantity, long SafetyStock, long Version, string Reference);
public sealed record ProductMirror(Guid Id, string Kind, bool Active);

public sealed class InventoryEngine : DriveCore.EventHandler
{
    public static async Task<StockPosition> Position(UnitOfWork unit, Guid tenant, Guid hub, Guid product)
    {
        await using var command = unit.Sql("SELECT on_hand,reserved,quarantine,safety,version FROM stock WHERE tenant=@tenant AND hub=@hub AND product=@product FOR UPDATE",
            ("tenant", tenant), ("hub", hub), ("product", product));
        await using var r = await command.ExecuteReaderAsync();
        return await r.ReadAsync() ? new(tenant, hub, product, r.GetInt64(0), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4)) :
            new(tenant, hub, product, 0, 0, 0, 0, 0);
    }
    public static async Task<StockPosition[]> Positions(UnitOfWork unit, Guid tenant, Guid? hub, Guid? product, int limit)
    {
        await using var command = unit.Sql("""
            SELECT hub,product,on_hand,reserved,quarantine,safety,version FROM stock
            WHERE tenant=@tenant AND (@hub::uuid IS NULL OR hub=@hub) AND (@product::uuid IS NULL OR product=@product)
            ORDER BY hub,product LIMIT @limit
            """, ("tenant", tenant), ("hub", hub), ("product", product), ("limit", limit));
        await using var r = await command.ExecuteReaderAsync();
        var rows = new List<StockPosition>();
        while (await r.ReadAsync()) rows.Add(new(tenant,r.GetGuid(0),r.GetGuid(1),r.GetInt64(2),r.GetInt64(3),r.GetInt64(4),r.GetInt64(5),r.GetInt64(6)));
        return rows.ToArray();
    }
    public static async Task SavePosition(UnitOfWork unit, StockPosition next)
    {
        var changed = await unit.Run("""
            INSERT INTO stock(tenant,hub,product,on_hand,reserved,quarantine,safety,version)
              VALUES(@tenant,@hub,@product,@hand,@reserved,@quarantine,@safety,@version)
            ON CONFLICT(tenant,hub,product) DO UPDATE SET on_hand=@hand,reserved=@reserved,quarantine=@quarantine,safety=@safety,version=@version
              WHERE stock.version=@previous
            """, ("tenant", next.TenantId), ("hub", next.HubId), ("product", next.ProductId), ("hand", next.OnHand),
            ("reserved", next.Reserved), ("quarantine", next.Quarantine), ("safety", next.SafetyStock),
            ("version", next.Version), ("previous", next.Version-1));
        if (changed!=1) throw new RuleViolation("Inventory changed concurrently.",409);
        await unit.Emit(DomainEvent.New("InventoryUpdated", next.TenantId, next.HubId, next.ProductId, next.Version,
            new StockChanged(next.HubId,next.ProductId,next.OnHand,next.Reserved,next.Quarantine,next.SafetyStock)));
    }
    public async Task Handle(UnitOfWork unit, DomainEvent message)
    {
        if (message.Type is "HubRegistered" or "ProductUpdated")
        {
            var kind = message.Type == "HubRegistered" ? "hub" : "product";
            var revision = await unit.Get<long>($"{kind}-revision", message.TenantId, message.AggregateId);
            if (revision is not null && revision.Data >= message.AggregateVersion) return;
            var previous = await unit.Get<JsonElement>(kind, message.TenantId, message.AggregateId);
            await unit.Save(kind, message.TenantId, message.AggregateId, message.Data, previous?.Version ?? 0);
            await unit.Save($"{kind}-revision", message.TenantId, message.AggregateId, message.AggregateVersion, revision?.Version ?? 0);
            return;
        }
        await unit.Lock($"{message.TenantId}:reservation:{message.AggregateId}");
        var old = await unit.Get<Reservation>("reservation", message.TenantId, message.AggregateId);
        if (message.Type == "OrderCreated")
        {
            if (old is not null) return;
            var request = message.Data.Deserialize<OrderRequested>(Json.Options) ?? throw new InvalidOperationException("Invalid order event.");
            if (request.Lines.Length is <1 or >50 || request.Lines.Select(l=>l.ProductId).Distinct().Count()!=request.Lines.Length)
                throw new InvalidOperationException("Invalid reservation lines.");
            var lines = request.Lines.Select(l => new ReservationLine(l.ProductId,l.Quantity)).OrderBy(l=>l.ProductId).ToArray();
            var positions = new List<StockPosition>(); string? rejection = null;
            var hub = await unit.Get<HubRegistered>("hub", message.TenantId, request.HubId);
            if (hub?.Data.Status != "Active") rejection = "Hub is inactive or its registry projection is not ready.";
            foreach (var line in lines)
            {
                await unit.Lock($"{message.TenantId}:stock:{request.HubId}:{line.ProductId}");
                var stock = await Position(unit, message.TenantId, request.HubId, line.ProductId);
                try { positions.Add(StockRules.Reserve(stock,line.Quantity)); }
                catch (RuleViolation) { rejection = "Insufficient stock."; }
            }
            var reservation = new Reservation(request.OrderId,request.HubId,lines,rejection is null ? "Held" : "Rejected",DateTimeOffset.UtcNow.AddMinutes(15));
            await unit.Save("reservation",message.TenantId,request.OrderId,reservation,0);
            await unit.Run("INSERT INTO reservations VALUES(@tenant,@id,@hub,@lines::jsonb,@status,@expires)",
                ("tenant",message.TenantId),("id",request.OrderId),("hub",request.HubId),("lines",Json.Write(lines)),("status",reservation.Status),("expires",reservation.Expires));
            if (rejection is null) foreach (var stock in positions) await SavePosition(unit,stock);
            await unit.Emit(DomainEvent.New(rejection is null ? "InventoryReserved" : "InventoryReservationRejected",message.TenantId,request.HubId,request.OrderId,1,
                new ReservationResult(request.OrderId,request.HubId,rejection)));
        }
        else if (message.Type is "ReservationReleaseRequested" or "ReservationCommitRequested")
        {
            var request = message.Data.Deserialize<ReservationResult>(Json.Options) ?? throw new InvalidOperationException("Invalid reservation command.");
            var commit = message.Type=="ReservationCommitRequested";
            if (old is null)
            {
                // A cancellation may overtake reservation creation; retain a tombstone so delayed creation cannot hold stock.
                if (commit) throw new InvalidOperationException("Commit preceded a confirmed reservation.");
                await unit.Save("reservation",message.TenantId,request.OrderId,new Reservation(request.OrderId,request.HubId,[],"Released",DateTimeOffset.UtcNow),0);
                return;
            }
            if(commit && old.Data.Status=="Committed")
            {
                await unit.Emit(DomainEvent.New("InventoryCommitted",message.TenantId,old.Data.HubId,old.Id,old.Version,
                    new ReservationResult(old.Id,old.Data.HubId)));
                return;
            }
            if (old.Data.Status!="Held" || old.Data.Expires<=DateTimeOffset.UtcNow)
            {
                if (commit) await unit.Emit(DomainEvent.New("InventoryCommitRejected",message.TenantId,request.HubId,request.OrderId,old.Version,
                    request with { Reason="Reservation expired or was released." }));
                if (old.Data.Status=="Held") await Settle(unit,message.TenantId,old,false,"Expired");
                return;
            }
            await Settle(unit,message.TenantId,old,commit,commit ? "Committed" : "Released");
        }
    }
    public static async Task Settle(UnitOfWork unit, Guid tenant, Stored<Reservation> reservation, bool commit, string status)
    {
        foreach (var line in reservation.Data.Lines.OrderBy(l=>l.ProductId))
        {
            await unit.Lock($"{tenant}:stock:{reservation.Data.HubId}:{line.ProductId}");
            var stock = await Position(unit,tenant,reservation.Data.HubId,line.ProductId);
            await SavePosition(unit,commit ? StockRules.Commit(stock,line.Quantity) : StockRules.Release(stock,line.Quantity));
            if (commit) await unit.Run("INSERT INTO stock_ledger VALUES(@id,@tenant,@hub,@product,@delta,'OrderCompleted',@reference,'saga',now())",
                ("id",Guid.NewGuid()),("tenant",tenant),("hub",reservation.Data.HubId),("product",line.ProductId),
                ("delta",-line.Quantity),("reference",reservation.Id.ToString()));
        }
        var version = await unit.Save("reservation",tenant,reservation.Id,reservation.Data with { Status=status },reservation.Version);
        await unit.Run("UPDATE reservations SET status=@status WHERE tenant=@tenant AND id=@id",("status",status),("tenant",tenant),("id",reservation.Id));
        await unit.Emit(DomainEvent.New(commit ? "InventoryCommitted" : "InventoryReservationReleased",tenant,reservation.Data.HubId,reservation.Id,version,
            new ReservationResult(reservation.Id,reservation.Data.HubId,status)));
    }
}

public sealed class ExpiryWorker(Store store, NpgsqlDataSource data, ILogger<ExpiryWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await using var command = data.CreateCommand("SELECT tenant,id FROM reservations WHERE status='Held' AND expires<=now() LIMIT 100");
                var expired = new List<(Guid Tenant,Guid Id)>();
                await using (var r = await command.ExecuteReaderAsync(ct)) while (await r.ReadAsync(ct)) expired.Add((r.GetGuid(0),r.GetGuid(1)));
                foreach (var (tenant,id) in expired) await store.Transaction(async unit =>
                {
                    await unit.Lock($"{tenant}:inventory:events");
                    await unit.Lock($"{tenant}:reservation:{id}");
                    var reservation=await unit.Get<Reservation>("reservation",tenant,id);
                    if (reservation?.Data.Status=="Held") await InventoryEngine.Settle(unit,tenant,reservation,false,"Expired");
                    return true;
                },ct);
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { logger.LogError(e,"Reservation expiry sweep failed"); }
            try { await Task.Delay(TimeSpan.FromSeconds(15),ct); } catch (OperationCanceledException) when(ct.IsCancellationRequested) { break; }
        }
    }
}
