namespace DriveCore;

public sealed record RevenueTotal(string Currency, long Today, long Week, long Month, long Year);
public sealed record HubScore(Guid Id,string Name,string Region,string Kind,string Status,int Bays,double Latitude,double Longitude,
    long AvailableUnits,long LowStockPositions,long StockPositions,long CompletedOrders,RevenueTotal[] Revenue,DateTimeOffset? LastEvent);
public sealed record NationalSnapshot(DateTimeOffset GeneratedAt,string Consistency,string Coverage,HubScore[] Hubs,
    long DeadLetters,long PendingInbox,long PendingOutbox);
