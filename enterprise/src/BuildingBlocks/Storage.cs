using System.Security.Cryptography;
using System.Text;
using Npgsql;

namespace DriveCore;

public sealed class Store(NpgsqlDataSource source)
{
    public async Task<T> Transaction<T>(Func<UnitOfWork, Task<T>> action, CancellationToken ct = default)
    {
        await using var connection = await source.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        var unit = new UnitOfWork(connection, transaction, ct);
        var result = await action(unit);
        await transaction.CommitAsync(ct);
        return result;
    }
    public Task<T> Command<T>(Actor actor, Guid key, object input, Func<UnitOfWork, Task<T>> action, CancellationToken ct) =>
        Transaction(async unit =>
        {
            if (key == Guid.Empty) throw new RuleViolation("A UUID Idempotency-Key is required.");
            var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Json.Write(input))));
            var owner = $"{actor.Subject}:{key}";
            await unit.Lock($"{actor.Tenant}:command:{owner}");
            var previous = await unit.Get<Replay>("request", actor.Tenant, key, owner);
            if (previous is not null)
            {
                if (previous.Data.Digest != digest) throw new RuleViolation("Idempotency key reused with a different request.", 409);
                return Json.Read<T>(previous.Data.Response);
            }
            var result = await action(unit);
            await unit.Save("request", actor.Tenant, key, new Replay(digest, Json.Write(result)), 0, owner);
            return result;
        }, ct);
    private sealed record Replay(string Digest, string Response);
}

public sealed class UnitOfWork(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct)
{
    public NpgsqlCommand Sql(string sql, params (string Name, object? Value)[] parameters)
    {
        var command = new NpgsqlCommand(sql, connection, transaction);
        foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return command;
    }
    public async Task<int> Run(string sql, params (string Name, object? Value)[] parameters)
    {
        await using var command = Sql(sql, parameters);
        return await command.ExecuteNonQueryAsync(ct);
    }
    public async Task Lock(string resource)
    {
        await using var command = Sql("SELECT pg_advisory_xact_lock(hashtextextended(@resource,0))", ("resource", resource));
        await command.ExecuteNonQueryAsync(ct);
    }
    public async Task<Stored<T>?> Get<T>(string kind, Guid tenant, Guid id, string owner = "")
    {
        await using var command = Sql("SELECT body::text,version FROM aggregates WHERE tenant=@tenant AND kind=@kind AND id=@id AND owner=@owner",
            ("tenant", tenant), ("kind", kind), ("id", id), ("owner", owner));
        await using var reader = await command.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? new(id, Json.Read<T>(reader.GetString(0)), reader.GetInt64(1)) : null;
    }
    public async Task<Stored<T>[]> List<T>(string kind, Guid tenant, int limit = 200, int offset = 0)
    {
        await using var command = Sql("SELECT id,body::text,version FROM aggregates WHERE tenant=@tenant AND kind=@kind AND owner='' ORDER BY id LIMIT @limit OFFSET @offset",
            ("tenant", tenant), ("kind", kind), ("limit", limit), ("offset", offset));
        await using var reader = await command.ExecuteReaderAsync(ct);
        var rows = new List<Stored<T>>();
        while (await reader.ReadAsync(ct)) rows.Add(new(reader.GetGuid(0), Json.Read<T>(reader.GetString(1)), reader.GetInt64(2)));
        return rows.ToArray();
    }
    public async Task<Stored<T>[]> ListScoped<T>(string kind, Actor actor, bool registry, bool staff, int limit, int offset)
    {
        await using var command = Sql("""
            SELECT id,body::text,version FROM aggregates
            WHERE tenant=@tenant AND kind=@kind AND owner='' AND
            (@corporate OR (@registry AND id::text=ANY(@hubs)) OR
             (NOT @registry AND (body->>'customerSubject'=@subject OR (@staff AND body->>'hubId'=ANY(@hubs)))))
            ORDER BY id LIMIT @limit OFFSET @offset
            """, ("tenant", actor.Tenant), ("kind", kind), ("corporate", actor.Corporate), ("registry", registry),
            ("staff", staff), ("subject", actor.Subject), ("hubs", actor.Hubs.ToArray()), ("limit", limit), ("offset", offset));
        await using var reader = await command.ExecuteReaderAsync(ct);
        var rows = new List<Stored<T>>();
        while (await reader.ReadAsync(ct)) rows.Add(new(reader.GetGuid(0), Json.Read<T>(reader.GetString(1)), reader.GetInt64(2)));
        return rows.ToArray();
    }
    public async Task<long> Save<T>(string kind, Guid tenant, Guid id, T body, long expected, string owner = "")
    {
        var sql = expected == 0
            ? "INSERT INTO aggregates(tenant,kind,id,owner,body,version) VALUES(@tenant,@kind,@id,@owner,@body::jsonb,1) ON CONFLICT DO NOTHING"
            : "UPDATE aggregates SET body=@body::jsonb,version=version+1 WHERE tenant=@tenant AND kind=@kind AND id=@id AND owner=@owner AND version=@expected";
        var changed = await Run(sql, ("tenant", tenant), ("kind", kind), ("id", id), ("owner", owner), ("body", Json.Write(body)), ("expected", expected));
        if (changed != 1) throw new RuleViolation("Record already exists or its version changed.", 409);
        return expected + 1;
    }
    public Task Emit(DomainEvent message) => Run("INSERT INTO outbox(id,payload) VALUES(@id,@payload::jsonb)", ("id", message.Id), ("payload", Json.Write(message)));
    public Task Audit(Actor actor, string action, Guid target, Guid? hub = null) =>
        Run("INSERT INTO audit(tenant,subject,action,target,hub) VALUES(@tenant,@subject,@action,@target,@hub)",
            ("tenant", actor.Tenant), ("subject", actor.Subject), ("action", action), ("target", target), ("hub", hub));
}

public static class Migrations
{
    public static async Task Apply(NpgsqlDataSource source)
    {
        await using var c = await source.OpenConnectionAsync();
        await using var tx = await c.BeginTransactionAsync();
        await using var command = new NpgsqlCommand("""
            SELECT pg_advisory_xact_lock(887701);
            CREATE TABLE IF NOT EXISTS aggregates(
              tenant uuid NOT NULL, kind text NOT NULL, id uuid NOT NULL, owner text NOT NULL DEFAULT '',
              body jsonb NOT NULL, version bigint NOT NULL CHECK(version>0),
              PRIMARY KEY(tenant,kind,id,owner));
            CREATE TABLE IF NOT EXISTS audit(
              id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant uuid NOT NULL, subject text NOT NULL,
              action text NOT NULL, target uuid NOT NULL, hub uuid, created timestamptz NOT NULL DEFAULT now());
            CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant,created);
            CREATE TABLE IF NOT EXISTS outbox(id uuid PRIMARY KEY, payload jsonb NOT NULL, created timestamptz NOT NULL DEFAULT now(), delivered timestamptz);
            CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(created) WHERE delivered IS NULL;
            CREATE TABLE IF NOT EXISTS inbox(id uuid PRIMARY KEY, payload jsonb NOT NULL, received timestamptz NOT NULL DEFAULT now(),
              processed timestamptz, attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(), error text);
            CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(next_attempt) WHERE processed IS NULL AND attempts<10;
            CREATE TABLE IF NOT EXISTS stock(tenant uuid NOT NULL,hub uuid NOT NULL,product uuid NOT NULL,
              on_hand bigint NOT NULL DEFAULT 0 CHECK(on_hand>=0),
              reserved bigint NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=on_hand),
              quarantine bigint NOT NULL DEFAULT 0 CHECK(quarantine>=0),
              safety bigint NOT NULL DEFAULT 0 CHECK(safety>=0),version bigint NOT NULL DEFAULT 1,
              PRIMARY KEY(tenant,hub,product));
            CREATE INDEX IF NOT EXISTS stock_locator ON stock(tenant,product,hub);
            CREATE TABLE IF NOT EXISTS stock_ledger(id uuid PRIMARY KEY,tenant uuid NOT NULL,hub uuid NOT NULL,product uuid NOT NULL,
              delta bigint NOT NULL,reason text NOT NULL,reference text NOT NULL,subject text NOT NULL,created timestamptz NOT NULL DEFAULT now());
            CREATE TABLE IF NOT EXISTS reservations(tenant uuid NOT NULL,id uuid NOT NULL,hub uuid NOT NULL,
              lines jsonb NOT NULL,status text NOT NULL,expires timestamptz NOT NULL,PRIMARY KEY(tenant,id));
            CREATE INDEX IF NOT EXISTS reservation_expiry ON reservations(expires) WHERE status='Held';
            """, c, tx);
        await command.ExecuteNonQueryAsync();
        await tx.CommitAsync();
    }
}
