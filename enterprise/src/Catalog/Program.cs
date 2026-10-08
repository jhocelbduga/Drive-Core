using DriveCore;
using Npgsql;
using System.Text.Json;

var builder = Hosting.Create(args, "catalog");
Hosting.Database(builder);
if (Hosting.IsMigration(args))
{
    await using var source = NpgsqlDataSource.Create(Hosting.Required(builder.Configuration, "Database:Connection"));
    await Migrations.Apply(source); return;
}
builder.Services.AddSingleton<DriveCore.EventHandler, CatalogEvents>();
Messaging.Add(builder, "catalog", "HubRegistered");
var app = builder.Build();
Hosting.Configure(app);
app.MapGet("/products", async (HttpContext context, Store store, int? offset, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context);
    return await store.Transaction(async u => (await u.List<Product>("product", actor.Tenant, 100,
        (int)Rules.Amount(offset ?? 0, "Offset", 0, 10_000_000))).Select(row => new Stored<ProductView>(row.Id,
            new(row.Data.Id,row.Data.Sku,row.Data.Name,row.Data.Category,row.Data.Kind,row.Data.Price,row.Data.Currency,row.Data.Active),row.Version)), ct);
}).RequireAuthorization();
app.MapPost("/products", async (ProductInput input, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context); actor.Demand("Inventory Controller", "Product Owner");
    if (input.Id == Guid.Empty || !new[] { "Part", "Accessory", "Service" }.Contains(input.Kind)) throw new RuleViolation("Product UUID and valid kind required.");
    var product = new Product(input.Id, Rules.Text(input.Sku, "SKU", 60), Rules.Text(input.Name, "Name"),
        Rules.Text(input.Category, "Category"), input.Kind, Rules.Amount(input.Price, "Price"), Rules.Amount(input.Cost, "Cost"),
        Currency.Validate(input.Currency), true);
    return await store.Command(actor, Hosting.Key(context), input, async unit =>
    {
        await unit.Lock($"{actor.Tenant}:sku:{product.Sku}");
        var existing = await unit.Get<Guid>("sku", actor.Tenant, SkuId(product.Sku));
        if (existing is not null) throw new RuleViolation("SKU already exists.", 409);
        var version = await unit.Save("product", actor.Tenant, input.Id, product, 0);
        await unit.Save("sku", actor.Tenant, SkuId(product.Sku), input.Id, 0);
        await unit.Emit(DomainEvent.New("ProductUpdated", actor.Tenant, null, input.Id, version, product));
        await unit.Audit(actor, "ProductCreated", input.Id);
        return new Stored<Product>(input.Id, product, version);
    }, ct);
}).RequireAuthorization();
app.MapPut("/products/{id:guid}/price", async (Guid id, PriceInput input, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context); actor.Demand("Inventory Controller", "Hub Manager", "Product Owner");
    if (input.HubId == Guid.Empty) throw new RuleViolation("Branch-specific pricing requires a hub UUID.");
    actor.Hub(input.HubId);
    return await store.Command(actor, Hosting.Key(context), new { id, input }, async unit =>
    {
        var product = await unit.Get<Product>("product", actor.Tenant, id) ?? throw new RuleViolation("Product not found.", 404);
        var hub = await unit.Get<HubRegistered>("hub", actor.Tenant, input.HubId);
        if (hub?.Data.Status != "Active") throw new RuleViolation("Hub is inactive or its registry event has not arrived.", 409);
        var priceId = PriceId(input.HubId, id);
        var previous = await unit.Get<BranchPrice>("price", actor.Tenant, priceId);
        var version = previous?.Version ?? 0;
        Rules.Version(version, input.Version);
        var value = new BranchPrice(input.HubId, id, Rules.Amount(input.Price, "Price"), product.Data.Currency);
        var next = await unit.Save("price", actor.Tenant, priceId, value, version);
        await unit.Audit(actor, "BranchPriceChanged", id, input.HubId);
        return new Stored<BranchPrice>(priceId, value, next);
    }, ct);
}).RequireAuthorization();
app.MapPost("/quotes", async (QuoteInput input, HttpContext context, Store store, CancellationToken ct) =>
{
    var actor = Hosting.Actor(context); actor.Hub(input.HubId);
    if (input.Lines is null || input.Lines.Length is <1 or >50 || input.Lines.Select(l=>l.ProductId).Distinct().Count()!=input.Lines.Length) throw new RuleViolation("Provide 1-50 unique product lines.");
    return await store.Transaction(async unit =>
    {
        var hub = await unit.Get<HubRegistered>("hub", actor.Tenant, input.HubId);
        if (hub?.Data.Status != "Active") throw new RuleViolation("Hub is inactive or not synchronized.", 409);
        var lines = new List<QuotedLine>(); string? currency = null;
        foreach (var requested in input.Lines)
        {
            var p = (await unit.Get<Product>("product", actor.Tenant, requested.ProductId))?.Data ?? throw new RuleViolation("Unknown product.", 404);
            if (!p.Active || p.Kind == "Service") throw new RuleViolation("This inventory slice accepts active physical products only.");
            currency ??= p.Currency;
            if (currency != p.Currency) throw new RuleViolation("Mixed-currency orders are not supported.");
            var price = (await unit.Get<BranchPrice>("price", actor.Tenant, PriceId(input.HubId, p.Id)))?.Data.Price ?? p.Price;
            lines.Add(new(p.Id, p.Name, Rules.Amount(requested.Quantity, "Quantity", 1, 1000), price));
        }
        return new QuoteResult(lines.ToArray(), checked(lines.Sum(l => l.UnitPrice*l.Quantity)), currency!);
    }, ct);
}).RequireAuthorization();
await app.RunAsync();

static Guid SkuId(string sku) => new(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(sku))[..16]);
static Guid PriceId(Guid hub, Guid product) => new(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{hub}:{product}"))[..16]);
public sealed record Product(Guid Id, string Sku, string Name, string Category, string Kind, long Price, long Cost, string Currency, bool Active);
public sealed record ProductView(Guid Id, string Sku, string Name, string Category, string Kind, long Price, string Currency, bool Active);
public sealed record ProductInput(Guid Id, string Sku, string Name, string Category, string Kind, long Price, long Cost, string Currency);
public sealed record PriceInput(Guid HubId, long Price, long Version);
public sealed record BranchPrice(Guid HubId, Guid ProductId, long Price, string Currency);
public sealed record QuoteInput(Guid HubId, RequestedLine[] Lines);
public sealed record QuoteResult(QuotedLine[] Lines, long Total, string Currency);
public static class Currency
{
    public static string Validate(string value) => value is "PHP" or "GBP" ? value : throw new RuleViolation("This slice supports PHP and GBP minor units.");
}
public sealed class CatalogEvents : DriveCore.EventHandler
{
    public async Task Handle(UnitOfWork unit, DomainEvent message)
    {
        if (message.Type != "HubRegistered") return;
        var previous = await unit.Get<HubRegistered>("hub", message.TenantId, message.AggregateId);
        var hub = message.Data.Deserialize<HubRegistered>(Json.Options) ?? throw new InvalidOperationException("Hub event invalid.");
        var revision = await unit.Get<long>("hub-revision", message.TenantId, message.AggregateId);
        if (revision is not null && revision.Data >= message.AggregateVersion) return;
        await unit.Save("hub", message.TenantId, message.AggregateId, hub, previous?.Version ?? 0);
        await unit.Save("hub-revision", message.TenantId, message.AggregateId, message.AggregateVersion, revision?.Version ?? 0);
    }
}
