using DriveCore;
using Npgsql;

var builder = Hosting.Create(args, "hubs");
Hosting.Database(builder);
if (Hosting.IsMigration(args))
{
    await using var source = NpgsqlDataSource.Create(Hosting.Required(builder.Configuration, "Database:Connection"));
    await Migrations.Apply(source); return;
}
builder.Services.AddSingleton<DriveCore.EventHandler, NoEvents>();
Messaging.Add(builder, "hubs");
var app = builder.Build();
Hosting.Configure(app);
app.MapGet("/hubs", async (HttpContext context, Store store, int? offset, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context);
    return await store.Transaction(unit => unit.ListScoped<HubRegistered>("hub", actor, true, false, 200,
        checked((int)Rules.Amount(offset ?? 0, "Offset", 0, 1_000_000))), ct);
}).RequireAuthorization();
app.MapGet("/hubs/{id:guid}", async (Guid id, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context); actor.Hub(id);
    return await store.Transaction(async unit => await unit.Get<HubRegistered>("hub", actor.Tenant, id) ??
        throw new RuleViolation("Hub not found.", 404), ct);
}).RequireAuthorization();
app.MapPost("/hubs", async (HubInput input, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context); actor.Demand("Corporate Administrator");
    var id = input.Id == Guid.Empty ? throw new RuleViolation("Hub UUID required.") : input.Id;
    if (!new[] { "Hub", "Branch", "Service Centre", "Warehouse" }.Contains(input.Kind)) throw new RuleViolation("Unsupported facility kind.");
    if (!double.IsFinite(input.Latitude) || !double.IsFinite(input.Longitude) || Math.Abs(input.Latitude)>90 || Math.Abs(input.Longitude)>180) throw new RuleViolation("Invalid coordinates.");
    var hub = new HubRegistered(id, Rules.Text(input.Name, "Name"), Rules.Text(input.Region, "Region"), input.Kind,
        (int)Rules.Amount(input.Bays, "Bays", 0, 100), input.Latitude, input.Longitude, "Active");
    return await store.Command(actor, Hosting.Key(context), input, async unit =>
    {
        var version = await unit.Save("hub", actor.Tenant, id, hub, 0);
        await unit.Emit(DomainEvent.New("HubRegistered", actor.Tenant, id, id, version, hub));
        await unit.Audit(actor, "HubRegistered", id, id);
        return new Stored<HubRegistered>(id, hub, version);
    }, ct);
}).RequireAuthorization();
app.MapPut("/hubs/{id:guid}/status", async (Guid id, StatusInput input, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context); actor.Demand("Hub Manager", "Regional Manager"); actor.Hub(id);
    if (!new[] { "Active", "Suspended", "Closed" }.Contains(input.Status)) throw new RuleViolation("Invalid operational status.");
    return await store.Command(actor, Hosting.Key(context), new { id, input }, async unit =>
    {
        var previous = await unit.Get<HubRegistered>("hub", actor.Tenant, id) ?? throw new RuleViolation("Hub not found.", 404);
        Rules.Version(previous.Version, input.Version);
        var hub = previous.Data with { Status = input.Status };
        var version = await unit.Save("hub", actor.Tenant, id, hub, previous.Version);
        await unit.Emit(DomainEvent.New("HubRegistered", actor.Tenant, id, id, version, hub));
        await unit.Audit(actor, "HubStatusChanged", id, id);
        return new Stored<HubRegistered>(id, hub, version);
    }, ct);
}).RequireAuthorization();
await app.RunAsync();

public sealed record HubInput(Guid Id, string Name, string Region, string Kind, int Bays, double Latitude, double Longitude);
public sealed record StatusInput(string Status, long Version);
public sealed class NoEvents : DriveCore.EventHandler { public Task Handle(UnitOfWork unit, DomainEvent message) => Task.CompletedTask; }
