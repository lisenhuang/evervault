using System.Net;
using Evervault.Api.Controllers;
using Evervault.Api.Data;
using Evervault.Api.Services;
using Evervault.Api.Services.Ai;
using Evervault.Api.Services.Ai.Tools;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Pgvector.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.

builder.Services.AddControllers();
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

// --- Database (PostgreSQL + pgvector) ---
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(
        builder.Configuration.GetConnectionString("Default"),
        npgsql => npgsql.UseVector()));

// Persist Data Protection keys in the DB so admin cookies and the encrypted R2 secret survive
// container restarts with zero configuration (no keys/secrets on disk or in .env).
builder.Services.AddDataProtection()
    .PersistKeysToDbContext<AppDbContext>()
    .SetApplicationName("evervault");

// --- Auth: cookie-based sessions (no JWT secret to manage) ---
// AdminCookie (default) gates /admin; UserCookie gates the public /webapp end-user session. Both
// return API status codes instead of 302 redirects.
static void ApiCookie(CookieAuthenticationOptions options, string cookieName, int days)
{
    options.Cookie.Name = cookieName;
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Lax;
    options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest; // https at the edge / http locally
    options.ExpireTimeSpan = TimeSpan.FromDays(days);
    options.SlidingExpiration = true;
    options.Events.OnRedirectToLogin = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    };
    options.Events.OnRedirectToAccessDenied = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        return Task.CompletedTask;
    };
}
builder.Services
    .AddAuthentication(AdminController.Scheme)
    .AddCookie(AdminController.Scheme, options => ApiCookie(options, "ev_admin", 7))
    .AddCookie(AuthController.Scheme, options => ApiCookie(options, "ev_user", 30));
builder.Services.AddAuthorization();

// --- App services ---
builder.Services.AddSingleton<IEmbedder, HashingEmbedder>();
builder.Services.AddScoped<IStorageService, StorageService>();
builder.Services.AddScoped<IGoogleAuthService, GoogleAuthService>();
builder.Services.AddScoped<IBraveSearchService, BraveSearchService>();
// Web search is tiered: the dedicated search API first, Gemini's Google Search grounding (on the shared AI
// key pool) as the fallback when it is rate-limited or unconfigured. WebSearchService owns that chain.
builder.Services.AddScoped<IGeminiWebSearchService, GeminiWebSearchService>();
builder.Services.AddScoped<IWebSearchService, WebSearchService>();
builder.Services.AddScoped<IUrlFetchService, UrlFetchService>();
builder.Services.AddScoped<IErrorReportService, ErrorReportService>();
builder.Services.AddScoped<IAiCallLogService, AiCallLogService>();

// --- AI: keys, providers, failover, agent chat ---
builder.Services.AddHttpClient();
// ChatGPT (OAuth) chat streams the Responses API over SSE; a reasoning turn can far exceed the default
// 100s client timeout while we hold the stream, so this named client gets a long timeout.
builder.Services.AddHttpClient(OpenAiProvider.HttpClientName, c => c.Timeout = TimeSpan.FromMinutes(10));
// Web search (Brave) is a quick REST call; the factory default 100s timeout is ample.
builder.Services.AddHttpClient(BraveSearchService.HttpClientName);
// Resolving a grounding redirect means reading its Location header, NOT fetching the page behind it — so
// auto-redirect is off and each hop is inspected by hand (see GeminiWebSearchService.ResolveAsync).
builder.Services.AddHttpClient(GeminiWebSearchService.HttpClientName)
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
// Fetching a model-supplied URL is an SSRF sink, so this handler is locked down: connections are pinned to
// addresses vetted at connect time (closing the DNS-rebinding window), and redirects are NOT auto-followed
// so each hop can be re-validated. See UrlFetchService for the full rationale.
builder.Services.AddHttpClient(UrlFetchService.HttpClientName)
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.All,   // byte cap is applied post-decompression
        ConnectTimeout = TimeSpan.FromSeconds(8),
        ConnectCallback = UrlFetchService.SafeConnectAsync,
    });
builder.Services.AddSingleton<OpenRouterProvider>();
builder.Services.AddSingleton<GeminiProvider>();
builder.Services.AddSingleton<OpenAiProvider>();
builder.Services.AddSingleton<IOpenAiAccountId, OpenAiAccountIdAdapter>();
builder.Services.AddScoped<IOpenAiOAuthService, OpenAiOAuthService>();
builder.Services.AddSingleton<IAiProviderFactory, AiProviderFactory>();
builder.Services.AddSingleton<ProposalSigner>();
builder.Services.AddScoped<IAiKeyService, AiKeyService>();
builder.Services.AddScoped<KeyFailoverRunner>();
builder.Services.AddScoped<AgentService>();

// Server-side voice-message reply audio: one singleton that is both the injectable status registry and
// the hosted background worker, so a spoken reply is synthesized off the request thread and survives the
// browser tab being backgrounded (iOS Safari kills in-page TTS the moment the tab is suspended).
builder.Services.AddSingleton<VoiceReplySynthesizer>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<VoiceReplySynthesizer>());

// Agent tools (the only execution surface for the chat).
builder.Services.AddScoped<IAiTool, ListMemoriesTool>();
builder.Services.AddScoped<IAiTool, GetMemoryTool>();
builder.Services.AddScoped<IAiTool, SearchMemoriesTool>();
builder.Services.AddScoped<IAiTool, DbStatsTool>();
builder.Services.AddScoped<IAiTool, GetStorageStatusTool>();
builder.Services.AddScoped<IAiTool, GetAiKeysStatusTool>();
builder.Services.AddScoped<IAiTool, SqlQueryTool>();
builder.Services.AddScoped<IAiTool, CreateMemoryTool>();
builder.Services.AddScoped<IAiTool, UpdateMemoryTool>();
builder.Services.AddScoped<IAiTool, DeleteMemoryTool>();
builder.Services.AddScoped<IAiTool, UpdateStorageConfigTool>();
builder.Services.AddScoped<IAiTool, SqlExecTool>();
builder.Services.AddScoped<ToolRegistry>();

// Trust the in-container nginx reverse proxy for scheme/host/for headers.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders =
        ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

// CORS for the local Next.js (web) and Expo (app) dev clients (same-origin in Docker).
const string DevCorsPolicy = "DevClients";
builder.Services.AddCors(options =>
{
    options.AddPolicy(DevCorsPolicy, policy =>
        policy.WithOrigins(
                "http://localhost:3000",   // Next.js web dev server
                "http://localhost:8081",   // Expo / Metro dev server
                "http://localhost:19006")  // Expo web
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials());          // admin cookie across origins in native dev
});

var app = builder.Build();

// Apply EF Core migrations on startup, retrying while the DB finishes booting.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    for (var attempt = 1; ; attempt++)
    {
        try { db.Database.Migrate(); break; }
        catch (Exception ex) when (attempt < 15)
        {
            app.Logger.LogWarning("Database not ready (attempt {Attempt}): {Message}. Retrying in 2s...",
                attempt, ex.Message);
            Thread.Sleep(2000);
        }
    }

    // Build the chat-memory ANN index if the embedding dimension is already locked (runtime, not a
    // static migration, because HNSW needs the admin-chosen dimension). Best-effort; never fatal.
    Evervault.Api.Data.ChatMemoryVectorIndex.EnsureAsync(db, app.Logger).GetAwaiter().GetResult();
}

// Behind nginx: honor X-Forwarded-* before anything else in the pipeline.
app.UseForwardedHeaders();

// Serve the whole app under /api (nginx forwards /api/* unchanged).
app.UsePathBase("/api");

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

// Only redirect to HTTPS when an HTTPS port is actually configured (e.g. local
// `dotnet run` with the https profile). Behind nginx the container is http-only, so
// this is skipped and proxied traffic is not broken.
if (app.Configuration["ASPNETCORE_HTTPS_PORTS"] is not null
    || app.Configuration["HTTPS_PORTS"] is not null)
{
    app.UseHttpsRedirection();
}

app.UseCors(DevCorsPolicy);

app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

// Health checks -> /api/health and /api/health/db behind the proxy.
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapGet("/health/db", async (AppDbContext db) =>
{
    var canConnect = await db.Database.CanConnectAsync();
    string? pgvector = null;
    if (canConnect)
    {
        pgvector = await db.Database
            .SqlQuery<string>($"SELECT extversion AS \"Value\" FROM pg_extension WHERE extname = 'vector'")
            .FirstOrDefaultAsync();
    }
    return Results.Ok(new { db = canConnect ? "ok" : "down", pgvector });
});

app.Run();
