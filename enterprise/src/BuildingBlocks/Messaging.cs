using System.Diagnostics.Metrics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.AspNetCore.Builder;
using Npgsql;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace DriveCore;

public interface EventHandler
{
    Task Handle(UnitOfWork unit, DomainEvent message);
}

public sealed class EventTransport(IConfiguration configuration, string service, string[] bindings) : IAsyncDisposable
{
    private IConnection? connection;
    private IChannel? channel;
    private readonly SemaphoreSlim mutex = new(1, 1);
    private readonly SemaphoreSlim publishMutex = new(1, 1);
    public bool Ready => connection?.IsOpen == true && channel?.IsOpen == true;
    public async Task<IChannel> Channel(CancellationToken ct)
    {
        await mutex.WaitAsync(ct);
        try
        {
            if (Ready) return channel!;
            if (channel is not null) await channel.DisposeAsync();
            if (connection is not null) await connection.DisposeAsync();
            var factory = new ConnectionFactory {
                Uri = new Uri(Hosting.Required(configuration, "Messaging:Uri")), AutomaticRecoveryEnabled = true,
                ClientProvidedName = service
            };
            connection = await factory.CreateConnectionAsync(ct);
            channel = await connection.CreateChannelAsync(new CreateChannelOptions(
                publisherConfirmationsEnabled: true, publisherConfirmationTrackingEnabled: true), ct);
            await channel.ExchangeDeclareAsync("drivecore.events.v1", ExchangeType.Topic, durable: true, cancellationToken: ct);
            await channel.ExchangeDeclareAsync("drivecore.poison.v1", ExchangeType.Direct, durable: true, cancellationToken: ct);
            var topology = new Dictionary<string, string[]> {
                ["hubs"] = [],
                ["catalog"] = ["HubRegistered"],
                ["inventory"] = ["HubRegistered", "ProductUpdated", "OrderCreated", "ReservationCommitRequested", "ReservationReleaseRequested"],
                ["orders"] = ["InventoryReserved", "InventoryReservationRejected", "InventoryCommitted", "InventoryCommitRejected", "InventoryReservationReleased"],
                ["operations"] = ["HubRegistered", "InventoryUpdated", "OrderCompleted", "OrderReconciliationRequired"]
            };
            topology[service] = bindings;
            foreach (var (queue, topics) in topology)
            {
                await channel.QueueDeclareAsync(queue + ".poison", durable: true, exclusive: false, autoDelete: false,
                    arguments: new Dictionary<string, object?> { ["x-queue-type"] = "quorum" }, cancellationToken: ct);
                await channel.QueueBindAsync(queue + ".poison", "drivecore.poison.v1", queue, cancellationToken: ct);
                await channel.QueueDeclareAsync(queue, durable: true, exclusive: false, autoDelete: false,
                    arguments: new Dictionary<string, object?> {
                        ["x-queue-type"] = "quorum",
                        ["x-dead-letter-exchange"] = "drivecore.poison.v1", ["x-dead-letter-routing-key"] = queue
                    }, cancellationToken: ct);
                foreach (var topic in topics)
                    await channel.QueueBindAsync(queue, "drivecore.events.v1", topic, cancellationToken: ct);
            }
            await channel.BasicQosAsync(0, 32, false, ct);
            return channel;
        }
        finally { mutex.Release(); }
    }
    public async Task Publish(DomainEvent message, CancellationToken ct)
    {
        await publishMutex.WaitAsync(ct);
        try
        {
            var current = await Channel(ct);
            var properties = new BasicProperties { Persistent = true, ContentType = "application/json", MessageId = message.Id.ToString() };
            await current.BasicPublishAsync("drivecore.events.v1", message.Type, true, properties, Encoding.UTF8.GetBytes(Json.Write(message)), ct);
        }
        finally { publishMutex.Release(); }
    }
    public async ValueTask DisposeAsync()
    {
        if (channel is not null) await channel.DisposeAsync();
        if (connection is not null) await connection.DisposeAsync();
        mutex.Dispose();
        publishMutex.Dispose();
    }
}

public sealed class MessagePump(NpgsqlDataSource data, Store store, EventTransport transport,
    IServiceProvider services, ILogger<MessagePump> log, string service) : BackgroundService
{
    private static readonly Meter Meter = new("DriveCore.Events");
    private static readonly Counter<long> Sent = Meter.CreateCounter<long>("drivecore.outbox.sent");
    private static readonly Counter<long> Failed = Meter.CreateCounter<long>("drivecore.inbox.failures");
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var listener = Listen(ct);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Dispatch(ct);
                await Process(ct);
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                log.LogError(e, "Messaging pump dependency failure");
            }
            try { await Task.Delay(500, ct); } catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
        }
        await listener;
    }
    private async Task Listen(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var channel = await transport.Channel(ct);
                var consumer = new AsyncEventingBasicConsumer(channel);
                consumer.ReceivedAsync += async (_, args) =>
                {
                    try
                    {
                        DomainEvent message;
                        try
                        {
                            message = Json.Read<DomainEvent>(Encoding.UTF8.GetString(args.Body.Span));
                            EventRules.Validate(message);
                        }
                        catch (Exception e) when (e is JsonException or InvalidOperationException or RuleViolation)
                        {
                            log.LogError(e, "Poison broker envelope moved to {Queue}", service + ".poison");
                            await channel.BasicNackAsync(args.DeliveryTag, false, false, ct);
                            return;
                        }
                        await using var command = data.CreateCommand("INSERT INTO inbox(id,payload) VALUES(@id,@payload::jsonb) ON CONFLICT DO NOTHING");
                        command.Parameters.AddWithValue("id", message.Id);
                        command.Parameters.AddWithValue("payload", Json.Write(message));
                        await command.ExecuteNonQueryAsync(ct);
                        await channel.BasicAckAsync(args.DeliveryTag, false, ct);
                    }
                    catch (Exception e) when (!ct.IsCancellationRequested)
                    {
                        log.LogError(e, "Could not persist broker delivery {MessageId}", args.BasicProperties.MessageId);
                        // Broker redelivery retains the event when the durable inbox cannot accept it.
                        await Task.Delay(1000, ct);
                        await channel.BasicNackAsync(args.DeliveryTag, false, true, ct);
                    }
                };
                var tag = await channel.BasicConsumeAsync(service, false, consumer, ct);
                while (!ct.IsCancellationRequested && channel.IsOpen) await Task.Delay(1000, ct);
                if (channel.IsOpen) await channel.BasicCancelAsync(tag, cancellationToken: ct);
            }
            catch (Exception e) when (!ct.IsCancellationRequested) { log.LogError(e, "Consumer reconnect required"); }
            try { await Task.Delay(2000, ct); } catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
        }
    }
    private Task Dispatch(CancellationToken ct) => store.Transaction(async unit =>
    {
        DomainEvent? message = null;
        await using (var command = unit.Sql("SELECT payload::text FROM outbox WHERE delivered IS NULL ORDER BY created LIMIT 1 FOR UPDATE SKIP LOCKED"))
        await using (var reader = await command.ExecuteReaderAsync(ct))
            if (await reader.ReadAsync(ct)) message = Json.Read<DomainEvent>(reader.GetString(0));
        if (message is null) return false;
        await transport.Publish(message, ct);
        await unit.Run("UPDATE outbox SET delivered=now() WHERE id=@id", ("id", message.Id));
        Sent.Add(1, new KeyValuePair<string, object?>("service", service));
        return true;
    }, ct);
    private async Task Process(CancellationToken ct)
    {
        Guid? failedId = null;
        try
        {
            await store.Transaction(async unit =>
            {
                DomainEvent? message = null;
                await using (var command = unit.Sql("SELECT payload::text FROM inbox WHERE processed IS NULL AND attempts<10 AND next_attempt<=now() ORDER BY received LIMIT 1 FOR UPDATE SKIP LOCKED"))
                await using (var reader = await command.ExecuteReaderAsync(ct))
                    if (await reader.ReadAsync(ct)) message = Json.Read<DomainEvent>(reader.GetString(0));
                if (message is null) return false;
                failedId = message.Id;
                // A tenant-wide handler lock serializes aggregate updates while inbox rows remain partitionable between tenants.
                await unit.Lock($"{message.TenantId}:{service}:events");
                await services.GetRequiredService<EventHandler>().Handle(unit, message);
                await unit.Run("UPDATE inbox SET processed=now(),error=NULL WHERE id=@id", ("id", message.Id));
                return true;
            }, ct);
        }
        catch (Exception e) when (failedId.HasValue && !ct.IsCancellationRequested)
        {
            log.LogError(e, "Event {EventId} failed; retained for bounded retry/dead-letter inspection", failedId);
            await using var command = data.CreateCommand("""
                UPDATE inbox SET attempts=attempts+1,error=@error,
                  next_attempt=now()+(LEAST(300,POWER(2,attempts+1))::text||' seconds')::interval
                WHERE id=@id AND processed IS NULL
                """);
            command.Parameters.AddWithValue("error", e.GetType().Name);
            command.Parameters.AddWithValue("id", failedId.Value);
            await command.ExecuteNonQueryAsync(ct);
            Failed.Add(1, new KeyValuePair<string, object?>("service", service));
        }
    }
}

public static class Messaging
{
    public static void Add(WebApplicationBuilder builder, string service, params string[] bindings)
    {
        builder.Services.AddSingleton(p => new EventTransport(p.GetRequiredService<IConfiguration>(), service, bindings));
        builder.Services.AddSingleton<IHostedService>(p => new MessagePump(p.GetRequiredService<NpgsqlDataSource>(),
            p.GetRequiredService<Store>(), p.GetRequiredService<EventTransport>(), p, p.GetRequiredService<ILogger<MessagePump>>(), service));
    }
}
