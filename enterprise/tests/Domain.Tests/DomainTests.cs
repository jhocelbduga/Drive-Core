using System.Security.Claims;
using System.Text.Json;
using DriveCore;
using DriveCore.Inventory;
using DriveCore.Orders;
using Xunit;

namespace DriveCore.Tests;

public class DomainTests
{
    private static readonly Guid Tenant = Guid.NewGuid(), Hub = Guid.NewGuid(), Product = Guid.NewGuid();
    private static StockPosition Stock(long hand = 10, long reserved = 0) => new(Tenant, Hub, Product, hand, reserved, 0, 2, 1);
    private static Order Order(string status) => new(Guid.NewGuid(), Hub, "customer-1", [], 12000, "PHP", status,
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(5));
    private static Actor Actor(string subject, params string[] roles) => new(Tenant, subject, roles.ToHashSet(), [Hub.ToString()]);

    [Fact]
    public void ClaimsRequireTenantAndSubject()
    {
        Assert.Throws<RuleViolation>(() => DriveCore.Actor.From(new ClaimsPrincipal()));
        var claims = new ClaimsPrincipal(new ClaimsIdentity([new Claim("tenant_id", Tenant.ToString()), new Claim("sub", "staff"),
            new Claim("roles", "Cashier"), new Claim("hub_ids", Hub.ToString().ToUpperInvariant())], "test"));
        var actor = DriveCore.Actor.From(claims);
        Assert.Equal(Tenant, actor.Tenant); actor.Demand("Cashier"); actor.Hub(Hub);
        Assert.Throws<RuleViolation>(() => actor.Hub(Guid.NewGuid()));
        Assert.Throws<RuleViolation>(() => actor.Demand("Hub Manager"));
    }
    [Theory]
    [InlineData("Corporate Administrator")]
    [InlineData("Product Owner")]
    public void CorporateIsExplicit(string role)
    {
        var actor = Actor("manager", role);
        actor.Hub(Guid.NewGuid()); actor.Demand("Cashier");
        Assert.Throws<RuleViolation>(() => actor.Hub(Guid.Empty));
    }
    [Fact]
    public void ReservationCommitChangesBothBalancesOnce()
    {
        var held = StockRules.Reserve(Stock(), 4);
        Assert.Equal(6, held.Available);
        var committed = StockRules.Commit(held, 4);
        Assert.Equal(6, committed.OnHand); Assert.Equal(0, committed.Reserved); Assert.Equal(3, committed.Version);
        Assert.Throws<RuleViolation>(() => StockRules.Commit(committed, 4));
    }
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(1001)]
    public void InvalidReservationQuantitiesFail(long quantity) => Assert.Throws<RuleViolation>(() => StockRules.Reserve(Stock(), quantity));
    [Fact]
    public void CannotOversellOrReleaseUnheldStock()
    {
        Assert.Throws<RuleViolation>(() => StockRules.Reserve(Stock(10, 8), 3));
        Assert.Throws<RuleViolation>(() => StockRules.Release(Stock(), 1));
        Assert.Equal(10, StockRules.Release(Stock(10, 8), 8).Available);
    }
    [Fact]
    public void ReceiveRequiresPositiveBoundedQuantity()
    {
        Assert.Equal(25, StockRules.Receive(Stock(), 15).OnHand);
        Assert.Throws<RuleViolation>(() => StockRules.Receive(Stock(), 0));
        Assert.Throws<RuleViolation>(() => StockRules.Receive(Stock(), 1000001));
        Assert.Throws<OverflowException>(() => StockRules.Receive(Stock(long.MaxValue), 1));
    }
    [Fact]
    public void OnlyInventoryCommitCanCompleteSettledOrder()
    {
        var order = OrderRules.Reserve(Order("PendingReservation"));
        Assert.Equal("AwaitingSettlement", order.Status);
        var paid = OrderRules.Settle(order, "BANK-123");
        Assert.Equal("CommittingInventory", paid.Status);
        Assert.Null(paid.CompletedAt);
        var complete = OrderRules.Complete(paid);
        Assert.Equal("Completed", complete.Status); Assert.NotNull(complete.CompletedAt);
        Assert.Throws<RuleViolation>(() => OrderRules.Cancel(paid));
        Assert.Throws<InvalidOperationException>(() => OrderRules.Complete(order));
    }
    [Theory]
    [InlineData("Completed")]
    [InlineData("Cancelled")]
    [InlineData("Rejected")]
    [InlineData("SettlementReconciliationRequired")]
    public void TerminalStatesCannotSettleOrCancel(string status)
    {
        Assert.Throws<RuleViolation>(() => OrderRules.Settle(Order(status), "REF"));
        Assert.Throws<RuleViolation>(() => OrderRules.Cancel(Order(status)));
    }
    [Fact]
    public void CustomerOwnershipAndMixedStaffRolesAreExplicit()
    {
        var order = Order("AwaitingSettlement");
        Assert.True(OrderRules.Visible(Actor("customer-1", "Customer"), order));
        Assert.False(OrderRules.Visible(Actor("customer-2", "Customer"), order));
        Assert.False(OrderRules.Visible(Actor("unknown", "Unrecognized"), order));
        Assert.True(OrderRules.Visible(Actor("staff", "Cashier", "Customer"), order));
        Assert.False(OrderRules.Visible(Actor("staff", "Cashier") with { Hubs = [] }, order));
        Assert.True(OrderRules.Visible(Actor("owner", "Corporate Administrator"), order));
    }
    [Fact]
    public void PoisonEnvelopeIsRejected()
    {
        var valid = DomainEvent.New("InventoryUpdated", Tenant, Hub, Product, 1, new StockChanged(Hub, Product, 10, 2, 0, 2));
        EventRules.Validate(valid);
        Assert.Throws<RuleViolation>(() => EventRules.Validate(valid with { SchemaVersion = 2 }));
        Assert.Throws<RuleViolation>(() => EventRules.Validate(valid with { TenantId = Guid.Empty }));
        Assert.Throws<RuleViolation>(() => EventRules.Validate(valid with { Data = JsonSerializer.SerializeToElement("bad") }));
        Assert.Throws<RuleViolation>(() => EventRules.Validate(valid with { AggregateVersion = 0 }));
    }
    [Fact]
    public void OptimisticVersionRejectsStaleWrites()
    {
        Rules.Version(3, 3);
        var error = Assert.Throws<RuleViolation>(() => Rules.Version(3, 2));
        Assert.Equal(409, error.Status);
    }
}
