using DriveCore;

namespace DriveCore.Orders;

public sealed record Order(Guid Id, Guid HubId, string CustomerSubject, QuotedLine[] Lines, long Total, string Currency,
    string Status, DateTimeOffset Created, DateTimeOffset ReservationDeadline, string? Failure = null,
    string? SettlementReference = null, DateTimeOffset? CompletedAt = null);

public static class OrderRules
{
    public static Order Reserve(Order order) => order.Status=="PendingReservation" ? order with { Status="AwaitingSettlement" } : order;
    public static Order Settle(Order order, string reference)
    {
        if (order.Status!="AwaitingSettlement") throw new RuleViolation("Only reserved orders can record a settlement.",409);
        return order with { Status="CommittingInventory",SettlementReference=Rules.Text(reference,"External settlement reference") };
    }
    public static Order Cancel(Order order)
    {
        if (order.Status is not ("PendingReservation" or "AwaitingSettlement")) throw new RuleViolation("Order cannot be cancelled in its current state.",409);
        return order with { Status="Cancelled" };
    }
    public static Order Complete(Order order)
    {
        if(order.Status!="CommittingInventory") throw new InvalidOperationException("Unexpected inventory commit.");
        return order with { Status="Completed",CompletedAt=DateTimeOffset.UtcNow };
    }
    public static bool Staff(Actor actor) =>
        new[] { "Sales Clerk", "Cashier", "Hub Manager", "Hub Supervisor", "Regional Manager", "Hub Owner" }.Any(actor.Roles.Contains);
    public static bool Visible(Actor actor, Order order) => actor.Corporate || order.CustomerSubject==actor.Subject ||
        actor.Hubs.Contains(order.HubId.ToString()) && Staff(actor);
}
