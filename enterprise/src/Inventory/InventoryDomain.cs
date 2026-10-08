using DriveCore;

namespace DriveCore.Inventory;

public static class StockRules
{
    public static StockPosition Receive(StockPosition stock, long quantity) =>
        stock with { OnHand = checked(stock.OnHand + Rules.Amount(quantity, "Quantity", 1, 1_000_000)), Version = stock.Version + 1 };
    public static StockPosition Reserve(StockPosition stock, long quantity)
    {
        Rules.Amount(quantity, "Quantity", 1, 1000);
        if (stock.Available < quantity) throw new RuleViolation("Insufficient available stock.", 409);
        return stock with { Reserved = checked(stock.Reserved + quantity), Version = stock.Version + 1 };
    }
    public static StockPosition Release(StockPosition stock, long quantity)
    {
        Rules.Amount(quantity, "Quantity", 1, 1000);
        if (stock.Reserved < quantity) throw new RuleViolation("Reservation balance does not reconcile.", 409);
        return stock with { Reserved = stock.Reserved - quantity, Version = stock.Version + 1 };
    }
    public static StockPosition Commit(StockPosition stock, long quantity)
    {
        var released = Release(stock, quantity);
        return released with { OnHand = checked(stock.OnHand - quantity) };
    }
}

public sealed record Reservation(Guid OrderId, Guid HubId, ReservationLine[] Lines, string Status, DateTimeOffset Expires);
