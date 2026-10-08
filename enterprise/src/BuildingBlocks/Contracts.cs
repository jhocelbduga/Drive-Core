using System.Security.Claims;
using System.Text.Json;

namespace DriveCore;

public sealed class RuleViolation(string message, int status = 400) : Exception(message)
{
    public int Status { get; } = status;
}

public static class Rules
{
    public static string Text(string? value, string field, int max = 200)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > max) throw new RuleViolation($"{field} requires 1-{max} characters.");
        return value.Trim();
    }
    public static long Amount(long value, string field, long min = 0, long max = 1_000_000_000)
    {
        if (value < min || value > max) throw new RuleViolation($"{field} must be between {min} and {max}.");
        return value;
    }
    public static void Version(long actual, long expected)
    {
        if (actual != expected) throw new RuleViolation("Concurrent change: reload the record before retrying.", 409);
    }
}

public sealed record Actor(Guid Tenant, string Subject, HashSet<string> Roles, HashSet<string> Hubs)
{
    public static Actor From(ClaimsPrincipal principal)
    {
        var tenant = principal.FindFirstValue("tenant_id");
        if (!Guid.TryParse(tenant, out var id) || id == Guid.Empty) throw new RuleViolation("A valid tenant_id claim is required.", 403);
        var roles = principal.FindAll("roles").Concat(principal.FindAll(ClaimTypes.Role)).Select(c => c.Value).ToHashSet(StringComparer.Ordinal);
        var hubs = principal.FindAll("hub_ids").SelectMany(c => c.Value.Split(',', StringSplitOptions.RemoveEmptyEntries))
            .Select(value => Guid.TryParse(value, out var hub) && hub != Guid.Empty ? hub.ToString() :
                throw new RuleViolation("Assigned hub claims must contain valid UUIDs.", 403)).ToHashSet(StringComparer.Ordinal);
        var subject = principal.FindFirstValue("sub");
        if (string.IsNullOrWhiteSpace(subject)) throw new RuleViolation("Subject claim missing.", 403);
        return new(id, subject, roles, hubs);
    }
    public bool Corporate => Roles.Contains("Corporate Administrator") || Roles.Contains("Product Owner");
    public void Demand(params string[] allowed)
    {
        if (!Corporate && !allowed.Any(Roles.Contains)) throw new RuleViolation("Role does not permit this operation.", 403);
    }
    public void Hub(Guid id)
    {
        if (id == Guid.Empty || (!Corporate && !Hubs.Contains(id.ToString()))) throw new RuleViolation("Hub access denied.", 403);
    }
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
    public static string Write<T>(T value) => JsonSerializer.Serialize(value, Options);
    public static T Read<T>(string value) => JsonSerializer.Deserialize<T>(value, Options) ?? throw new InvalidOperationException("Missing payload.");
}

public sealed record DomainEvent(
    Guid Id, string Type, int SchemaVersion, Guid TenantId, Guid? HubId,
    Guid AggregateId, long AggregateVersion, DateTimeOffset OccurredAt, string? TraceId, JsonElement Data)
{
    public static DomainEvent New<T>(string type, Guid tenant, Guid? hub, Guid aggregate, long version, T data) =>
        new(Guid.NewGuid(), type, 1, tenant, hub, aggregate, version, DateTimeOffset.UtcNow,
            System.Diagnostics.Activity.Current?.Id, JsonSerializer.SerializeToElement(data, Json.Options));
}

public static class EventRules
{
    public static void Validate(DomainEvent message)
    {
        if (message.SchemaVersion != 1 || message.Id == Guid.Empty || message.TenantId == Guid.Empty ||
            message.AggregateId == Guid.Empty || message.AggregateVersion < 1 ||
            string.IsNullOrWhiteSpace(message.Type) || message.Data.ValueKind != JsonValueKind.Object)
            throw new RuleViolation("Unsupported or invalid event envelope.");
    }
}

public sealed record Stored<T>(Guid Id, T Data, long Version);
public sealed record Money(long MinorUnits, string Currency);
public sealed record StockChanged(Guid HubId, Guid ProductId, long OnHand, long Reserved, long Quarantine, long SafetyStock);
public sealed record ReservationLine(Guid ProductId, long Quantity);
public sealed record RequestedLine(Guid ProductId, long Quantity);
public sealed record QuotedLine(Guid ProductId, string Name, long Quantity, long UnitPrice);
public sealed record OrderRequested(Guid OrderId, Guid HubId, string CustomerSubject, QuotedLine[] Lines, long Total, string Currency);
public sealed record ReservationResult(Guid OrderId, Guid HubId, string? Reason = null);
public sealed record OrderFinalized(Guid OrderId, Guid HubId, long Total, string Currency, string CustomerSubject);
public sealed record HubRegistered(Guid HubId, string Name, string Region, string Kind, int Bays, double Latitude, double Longitude, string Status);
public sealed record StockPosition(Guid TenantId, Guid HubId, Guid ProductId, long OnHand, long Reserved, long Quarantine, long SafetyStock, long Version)
{
    public long Available => OnHand - Reserved;
}
