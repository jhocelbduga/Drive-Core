using DriveCore;
using Npgsql;

public static class OperationsSchema
{
    public static async Task Apply(NpgsqlDataSource source)
    {
        await Migrations.Apply(source);
        await using var command=source.CreateCommand("""
            CREATE TABLE IF NOT EXISTS hub_scores(tenant uuid NOT NULL,hub uuid NOT NULL,available bigint NOT NULL DEFAULT 0,
              low bigint NOT NULL DEFAULT 0,positions bigint NOT NULL DEFAULT 0,orders bigint NOT NULL DEFAULT 0,last_event timestamptz,PRIMARY KEY(tenant,hub));
            CREATE TABLE IF NOT EXISTS daily_revenue(tenant uuid NOT NULL,hub uuid NOT NULL,day date NOT NULL,currency text NOT NULL,
              amount bigint NOT NULL,PRIMARY KEY(tenant,hub,day,currency));
            CREATE TABLE IF NOT EXISTS order_facts(tenant uuid NOT NULL,id uuid NOT NULL,PRIMARY KEY(tenant,id));
            """);
        await command.ExecuteNonQueryAsync();
    }
}
