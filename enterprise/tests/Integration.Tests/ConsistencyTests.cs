using DriveCore;
using DriveCore.Inventory;
using DriveCore.Orders;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using Xunit;

namespace DriveCore.IntegrationTests;

public sealed class DatabaseFixture : IAsyncLifetime
{
    private readonly string schema = "validation_" + Guid.NewGuid().ToString("N");
    private NpgsqlDataSource? admin;
    public NpgsqlDataSource Source { get; private set; } = null!;
    public Store Store { get; private set; } = null!;
    public async Task InitializeAsync()
    {
        var value = Environment.GetEnvironmentVariable("DRIVECORE_TEST_DATABASE") ??
            throw new InvalidOperationException("Integration tests require DRIVECORE_TEST_DATABASE and a running PostgreSQL/RabbitMQ stack. They do not silently skip.");
        var connection = new NpgsqlConnectionStringBuilder(value);
        if (connection.Database != "drivecore_tests") throw new InvalidOperationException("Only the dedicated drivecore_tests database is permitted.");
        admin = NpgsqlDataSource.Create(connection.ConnectionString);
        await using var command = admin.CreateCommand($"CREATE SCHEMA {schema}");
        await command.ExecuteNonQueryAsync();
        connection.SearchPath = schema;
        Source = NpgsqlDataSource.Create(connection.ConnectionString);
        Store = new Store(Source);
        await OperationsSchema.Apply(Source);
    }
    public async Task DisposeAsync()
    {
        if (Source is not null) await Source.DisposeAsync();
        if (admin is not null)
        {
            await using var command = admin.CreateCommand($"DROP SCHEMA {schema} CASCADE");
            await command.ExecuteNonQueryAsync();
            await admin.DisposeAsync();
        }
    }
}

public class ConsistencyTests(DatabaseFixture database) : IClassFixture<DatabaseFixture>
{
    private Store Store => database.Store;
    private static Actor Actor(Guid tenant, Guid hub) => new(tenant, "staff", ["Cashier"], [hub.ToString()]);
    private async Task<(Guid Tenant, Guid Hub, Guid Product)> Seed(long quantity)
    {
        var tenant=Guid.NewGuid(); var hub=Guid.NewGuid(); var product=Guid.NewGuid();
        await Store.Transaction(async unit =>
        {
            await unit.Save("hub",tenant,hub,new HubRegistered(hub,"Test hub","NCR","Hub",2,14.6,121,"Active"),0);
            await InventoryEngine.SavePosition(unit,new(tenant,hub,product,quantity,0,0,2,1));
            return true;
        });
        return(tenant,hub,product);
    }
    private static DomainEvent Requested(Guid tenant,Guid hub,Guid product,Guid order,long quantity) =>
        DomainEvent.New("OrderCreated",tenant,hub,order,1,new OrderRequested(order,hub,"customer",
            [new(product,"Test item",quantity,10000)],quantity*10000,"PHP"));
    private Task Handle(DriveCore.EventHandler handler,DomainEvent message) => Store.Transaction(async unit =>
    {
        await unit.Lock($"{message.TenantId}:test:events"); await handler.Handle(unit,message); return true;
    });

    [Fact]
    public async Task IdempotencyIsDurableConcurrentAndTenantScoped()
    {
        var tenant=Guid.NewGuid(); var hub=Guid.NewGuid(); var actor=Actor(tenant,hub); var key=Guid.NewGuid(); var id=Guid.NewGuid();
        var executions=0;
        Task<Guid> Run() => Store.Command(actor,key,new{amount=100},async unit =>
        {
            Interlocked.Increment(ref executions); await unit.Save("proof",tenant,id,new{amount=100},0); return id;
        },CancellationToken.None);
        var replies=await Task.WhenAll(Enumerable.Range(0,20).Select(_=>Run()));
        Assert.All(replies,result=>Assert.Equal(id,result)); Assert.Equal(1,executions);
        await Assert.ThrowsAsync<RuleViolation>(()=>Store.Command(actor,key,new{amount=200},_=>Task.FromResult(id),CancellationToken.None));
        Assert.Null(await Store.Transaction(u=>u.Get<object>("proof",Guid.NewGuid(),id)));
    }
    [Fact]
    public async Task ConcurrentOrdersCannotOversell()
    {
        var(t,h,p)=await Seed(10); var engine=new InventoryEngine();
        await Task.WhenAll(Enumerable.Range(0,30).Select(_=>Handle(engine,Requested(t,h,p,Guid.NewGuid(),1))));
        var position=await Store.Transaction(u=>InventoryEngine.Position(u,t,h,p));
        Assert.Equal(10,position.Reserved); Assert.Equal(0,position.Available); Assert.Equal(10,position.OnHand);
        var held=await Store.Transaction(u=>u.List<Reservation>("reservation",t,100));
        Assert.Equal(10,held.Count(r=>r.Data.Status=="Held")); Assert.Equal(20,held.Count(r=>r.Data.Status=="Rejected"));
    }
    [Fact]
    public async Task CancellationCanOvertakeCreateAndDuplicateCommitIsSafe()
    {
        var(t,h,p)=await Seed(10); var engine=new InventoryEngine(); var cancelled=Guid.NewGuid();
        await Handle(engine,DomainEvent.New("ReservationReleaseRequested",t,h,cancelled,1,new ReservationResult(cancelled,h)));
        await Handle(engine,Requested(t,h,p,cancelled,4));
        var position=await Store.Transaction(u=>InventoryEngine.Position(u,t,h,p)); Assert.Equal(0,position.Reserved);
        var order=Guid.NewGuid(); await Handle(engine,Requested(t,h,p,order,4));
        var commit=DomainEvent.New("ReservationCommitRequested",t,h,order,2,new ReservationResult(order,h));
        await Handle(engine,commit); await Handle(engine,commit with{Id=Guid.NewGuid()});
        position=await Store.Transaction(u=>InventoryEngine.Position(u,t,h,p));
        Assert.Equal(6,position.OnHand); Assert.Equal(0,position.Reserved);
    }
    [Fact]
    public async Task ExpiredHoldReleasesStockAndRejectsSettlementCommit()
    {
        var(t,h,p)=await Seed(5); var order=Guid.NewGuid(); var engine=new InventoryEngine();
        await Handle(engine,Requested(t,h,p,order,3));
        await Store.Transaction(async u =>
        {
            var old=(await u.Get<Reservation>("reservation",t,order))!;
            await u.Save("reservation",t,order,old.Data with{Expires=DateTimeOffset.UtcNow.AddMinutes(-1)},old.Version); return true;
        });
        await Handle(engine,DomainEvent.New("ReservationCommitRequested",t,h,order,2,new ReservationResult(order,h)));
        var position=await Store.Transaction(u=>InventoryEngine.Position(u,t,h,p)); Assert.Equal(5,position.OnHand); Assert.Equal(0,position.Reserved);
        var reservation=await Store.Transaction(u=>u.Get<Reservation>("reservation",t,order)); Assert.Equal("Expired",reservation!.Data.Status);
    }
    [Fact]
    public async Task ProjectionIgnoresStaleStockAndDuplicateSalesFacts()
    {
        var t=Guid.NewGuid(); var h=Guid.NewGuid(); var p=Guid.NewGuid(); var events=new OperationsEvents();
        var newest=DomainEvent.New("InventoryUpdated",t,h,p,3,new StockChanged(h,p,10,4,0,7));
        await Handle(events,newest); await Handle(events,newest with{Id=Guid.NewGuid()});
        await Handle(events,DomainEvent.New("InventoryUpdated",t,h,p,2,new StockChanged(h,p,100,0,0,1)));
        var order=Guid.NewGuid(); var sale=DomainEvent.New("OrderCompleted",t,h,order,4,new OrderFinalized(order,h,12000,"PHP","customer"));
        await Handle(events,sale); await Handle(events,sale with{Id=Guid.NewGuid()});
        await using var command=database.Source.CreateCommand("SELECT available,low,positions,orders FROM hub_scores WHERE tenant=@tenant AND hub=@hub");
        command.Parameters.AddWithValue("tenant",t); command.Parameters.AddWithValue("hub",h);
        await using var reader=await command.ExecuteReaderAsync(); Assert.True(await reader.ReadAsync());
        Assert.Equal(6,reader.GetInt64(0)); Assert.Equal(1,reader.GetInt64(1)); Assert.Equal(1,reader.GetInt64(2)); Assert.Equal(1,reader.GetInt64(3));
    }
    [Fact]
    public async Task PaginationAppliesScopeBeforeLimit()
    {
        var t=Guid.NewGuid(); var allowed=Guid.NewGuid(); var denied=Guid.NewGuid();
        await Store.Transaction(async u =>
        {
            for(var i=0;i<30;i++)
            {
                var hub=i<20?denied:allowed; var id=Guid.NewGuid();
                await u.Save("order",t,id,new Order(id,hub,"another-customer",[],100,"PHP","PendingReservation",DateTimeOffset.UtcNow,DateTimeOffset.UtcNow.AddMinutes(5)),0);
            }
            return true;
        });
        var actor=Actor(t,allowed);
        var page=await Store.Transaction(u=>u.ListScoped<Order>("order",actor,false,OrderRules.Staff(actor),5,0));
        Assert.Equal(5,page.Length); Assert.All(page,row=>Assert.Equal(allowed,row.Data.HubId));
    }
    [Fact]
    public async Task BrokerDeliveryUsesDurableInboxAndDuplicatesAreProcessedOnce()
    {
        var uri=Environment.GetEnvironmentVariable("DRIVECORE_TEST_BROKER")??
            throw new InvalidOperationException("DRIVECORE_TEST_BROKER is required for real broker tests.");
        if(!System.Text.RegularExpressions.Regex.IsMatch(new Uri(uri).AbsolutePath,"^/drivecore-tests-[0-9a-f]{32}$"))
            throw new InvalidOperationException("Broker tests require a generated isolated drivecore-tests-* vhost, not the application vhost.");
        var queue="validation_"+Guid.NewGuid().ToString("N"); var type="Validation."+Guid.NewGuid().ToString("N");
        var configuration=new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?> {["Messaging:Uri"]=uri}).Build();
        await using var transport=new EventTransport(configuration,queue,[type]);
        using var services=new ServiceCollection().AddSingleton<DriveCore.EventHandler,ProofHandler>().BuildServiceProvider();
        using var pump=new MessagePump(database.Source,Store,transport,services,NullLogger<MessagePump>.Instance,queue);
        await pump.StartAsync(CancellationToken.None);
        var message=DomainEvent.New(type,Guid.NewGuid(),null,Guid.NewGuid(),1,new{proof=true});
        await transport.Publish(message,CancellationToken.None); await transport.Publish(message,CancellationToken.None);
        try
        {
            Stored<object>? proof=null;
            for(var i=0;i<100;i++)
            {
                proof=await Store.Transaction(u=>u.Get<object>("broker-proof",message.TenantId,message.Id));
                if(proof is not null)break; await Task.Delay(100);
            }
            Assert.NotNull(proof); Assert.Equal(1,proof.Version);
        }
        finally
        {
            using var shutdown=new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await pump.StopAsync(shutdown.Token);
            var channel=await transport.Channel(CancellationToken.None);
            await channel.QueueDeleteAsync(queue,false,false); await channel.QueueDeleteAsync(queue+".poison",false,false);
        }
    }
    private sealed class ProofHandler : DriveCore.EventHandler
    {
        public async Task Handle(UnitOfWork unit,DomainEvent message) => await unit.Save("broker-proof",message.TenantId,message.Id,new{processed=true},0);
    }
}
