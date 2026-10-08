using System.Net.Http.Headers;
using DriveCore;

var builder=Hosting.Create(args,"gateway");
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<DomainClient>();
builder.Services.AddGraphQLServer().AddQueryType<Queries>().AddMaxExecutionDepthRule(5).ModifyCostOptions(options=>
{
    options.EnforceCostLimits=true;
    options.MaxFieldCost=300;
    options.MaxTypeCost=5000;
}).ModifyRequestOptions(options=>
{
    options.IncludeExceptionDetails=false;
    options.ExecutionTimeout=TimeSpan.FromSeconds(10);
});
builder.Services.AddRateLimiter(options=>
{
    options.RejectionStatusCode=429;
    options.AddPolicy("api",context=>System.Threading.RateLimiting.RateLimitPartition.GetTokenBucketLimiter(
        $"{context.User.FindFirst("tenant_id")?.Value}:{context.User.FindFirst("sub")?.Value}",
        _=>new System.Threading.RateLimiting.TokenBucketRateLimiterOptions{TokenLimit=60,TokensPerPeriod=30,
            ReplenishmentPeriod=TimeSpan.FromSeconds(1),AutoReplenishment=true,QueueLimit=0}));
});
var app=builder.Build();
Hosting.Configure(app);
app.UseRateLimiter();
var routes=app.MapGroup("/api").RequireAuthorization().RequireRateLimiting("api");
foreach(var resource in new[]{"hubs","products","orders"})
{
    var service=resource=="hubs"?"Hubs":resource=="products"?"Catalog":"Orders";
    routes.MapGet("/"+resource,(HttpContext c,DomainClient client)=>client.Forward(c,service));
    routes.MapPost("/"+resource,(HttpContext c,DomainClient client)=>client.Forward(c,service));
}
routes.MapGet("/hubs/{id:guid}",(HttpContext c,DomainClient d)=>d.Forward(c,"Hubs"));
routes.MapPut("/hubs/{id:guid}/status",(HttpContext c,DomainClient d)=>d.Forward(c,"Hubs"));
routes.MapPut("/products/{id:guid}/price",(HttpContext c,DomainClient d)=>d.Forward(c,"Catalog"));
routes.MapGet("/orders/{id:guid}",(HttpContext c,DomainClient d)=>d.Forward(c,"Orders"));
routes.MapPost("/orders/{id:guid}/settle",(HttpContext c,DomainClient d)=>d.Forward(c,"Orders"));
routes.MapPost("/orders/{id:guid}/cancel",(HttpContext c,DomainClient d)=>d.Forward(c,"Orders"));
routes.MapGet("/stock/{id:guid}",(HttpContext c,DomainClient d)=>d.Forward(c,"Inventory"));
routes.MapPost("/stock/{id:guid}/receive",(HttpContext c,DomainClient d)=>d.Forward(c,"Inventory"));
routes.MapGet("/availability/{id:guid}",(HttpContext c,DomainClient d)=>d.Forward(c,"Inventory"));
routes.MapGet("/national",(HttpContext c,DomainClient d)=>d.Forward(c,"Operations"));
routes.MapGet("/me",(HttpContext context)=>
{
    var actor=Hosting.Actor(context);return new{actor.Tenant,actor.Subject,actor.Roles,actor.Hubs};
});
app.MapGraphQL("/graphql").RequireAuthorization().RequireRateLimiting("api");
await app.RunAsync();

public sealed class DomainClient(IHttpClientFactory clients,IConfiguration config,IHttpContextAccessor accessor)
{
    public async Task Forward(HttpContext context,string service)
    {
        _=Hosting.Actor(context);
        using var request=new HttpRequestMessage(new HttpMethod(context.Request.Method),
            Hosting.Required(config,$"Gateway:{service}")+context.Request.Path.Value![4..]+context.Request.QueryString);
        request.Headers.Authorization=AuthenticationHeaderValue.Parse(context.Request.Headers.Authorization.ToString());
        if(context.Request.Headers.TryGetValue("Idempotency-Key",out var key))request.Headers.TryAddWithoutValidation("Idempotency-Key",key.ToString());
        if(context.Request.Method is "POST" or "PUT")
        {
            request.Content=new StreamContent(context.Request.Body);
            request.Content.Headers.ContentType=new MediaTypeHeaderValue("application/json");
        }
        using var response=await clients.CreateClient("domains").SendAsync(request,context.RequestAborted);
        context.Response.StatusCode=(int)response.StatusCode;
        context.Response.ContentType=response.Content.Headers.ContentType?.ToString()??"application/json";
        context.Response.Headers.CacheControl="no-store";
        await response.Content.CopyToAsync(context.Response.Body,context.RequestAborted);
    }
    public async Task<NationalSnapshot> National(CancellationToken ct)
    {
        var context=accessor.HttpContext??throw new InvalidOperationException("HTTP context required.");
        var actor=Hosting.Actor(context);actor.Demand("Regional Manager","Hub Manager","Hub Owner");
        using var request=new HttpRequestMessage(HttpMethod.Get,Hosting.Required(config,"Gateway:Operations")+"/national");
        request.Headers.Authorization=AuthenticationHeaderValue.Parse(context.Request.Headers.Authorization.ToString());
        using var response=await clients.CreateClient("domains").SendAsync(request,ct);
        if(!response.IsSuccessStatusCode)throw new RuleViolation("National projection unavailable or unauthorized.",(int)response.StatusCode);
        return await response.Content.ReadFromJsonAsync<NationalSnapshot>(Json.Options,ct)??throw new InvalidOperationException("Invalid projection response.");
    }
}
public sealed class Queries
{
    [HotChocolate.CostAnalysis.Types.Cost(100)]
    public Task<NationalSnapshot> National([HotChocolate.Service]DomainClient client,CancellationToken ct)=>client.National(ct);
}
