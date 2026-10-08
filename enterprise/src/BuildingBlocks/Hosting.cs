using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace DriveCore;

public static class Hosting
{
    public static WebApplicationBuilder Create(string[] args, string service)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 65536);
        builder.Services.AddProblemDetails();
        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
        {
            options.Authority = Required(builder.Configuration, "Identity:Authority");
            options.Audience = Required(builder.Configuration, "Identity:Audience");
            options.RequireHttpsMetadata = !builder.Environment.IsDevelopment();
            options.MapInboundClaims = false;
            options.TokenValidationParameters.RoleClaimType = "roles";
            options.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);
        });
        builder.Services.AddAuthorization();
        builder.Services.AddHttpClient("domains", client => client.Timeout = TimeSpan.FromSeconds(8));
        builder.Services.AddOpenTelemetry().ConfigureResource(r => r.AddService(service))
            .WithTracing(t => t.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation().AddOtlpExporter())
            .WithMetrics(m => m.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation()
                .AddMeter("DriveCore.Events").AddPrometheusExporter().AddOtlpExporter());
        return builder;
    }
    public static void Database(WebApplicationBuilder builder)
    {
        builder.Services.AddSingleton(NpgsqlDataSource.Create(Required(builder.Configuration, "Database:Connection")));
        builder.Services.AddSingleton<Store>();
    }
    public static bool IsMigration(string[] args) => args.Contains("--migrate");
    public static void Configure(WebApplication app)
    {
        app.UseExceptionHandler(error => error.Run(async context =>
        {
            var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
            var status = exception switch { RuleViolation r => r.Status, PostgresException p when p.SqlState == "23505" => 409, _ => 500 };
            if (status == 500) app.Logger.LogError(exception, "Unhandled operational failure");
            context.Response.StatusCode = status;
            await context.Response.WriteAsJsonAsync(new {
                type = "about:blank", title = status == 500 ? "Operation failed. Use the trace ID when contacting support." : exception?.Message,
                status, traceId = context.TraceIdentifier
            });
        }));
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));
        app.MapGet("/health/ready", async (IServiceProvider services, IConfiguration config, CancellationToken ct) =>
        {
            try
            {
                var data = services.GetService<NpgsqlDataSource>();
                if (data is not null)
                {
                    await using var command = data.CreateCommand("SELECT 1");
                    await command.ExecuteScalarAsync(ct);
                }
                var transport = services.GetService<EventTransport>();
                if (transport is not null && !transport.Ready) return Results.StatusCode(503);
                if (config["Gateway:Orders"] is not null)
                {
                    var client = services.GetRequiredService<IHttpClientFactory>().CreateClient("domains");
                    foreach (var name in new[] { "Hubs", "Catalog", "Inventory", "Orders", "Operations" })
                        if (!(await client.GetAsync(Required(config, $"Gateway:{name}") + "/health/ready", ct)).IsSuccessStatusCode) return Results.StatusCode(503);
                }
                return Results.Ok(new { status = "ready" });
            }
            catch (Exception e) when (e is NpgsqlException or HttpRequestException or TaskCanceledException)
            {
                app.Logger.LogWarning(e, "Dependency readiness failed");
                return Results.StatusCode(503);
            }
        });
        app.MapPrometheusScrapingEndpoint("/metrics");
    }
    public static Guid Key(HttpContext context) =>
        Guid.TryParse(context.Request.Headers["Idempotency-Key"], out var id) && id != Guid.Empty ? id :
            throw new RuleViolation("A UUID Idempotency-Key header is required.");
    public static string Required(IConfiguration config, string key) =>
        !string.IsNullOrWhiteSpace(config[key]) ? config[key]! : throw new InvalidOperationException($"Configuration {key} is required.");
    public static Actor Actor(HttpContext context) => DriveCore.Actor.From(context.User);
}
