using Microsoft.AspNetCore.HttpOverrides;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.

builder.Services.AddControllers();
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

// Trust the in-container nginx reverse proxy for scheme/host/for headers.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders =
        ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

// CORS for the local Next.js (web) and Expo (app) dev clients.
const string DevCorsPolicy = "DevClients";
builder.Services.AddCors(options =>
{
    options.AddPolicy(DevCorsPolicy, policy =>
        policy.WithOrigins(
                "http://localhost:3000",   // Next.js web dev server
                "http://localhost:8081",   // Expo / Metro dev server
                "http://localhost:19006")  // Expo web
            .AllowAnyHeader()
            .AllowAnyMethod());
});

var app = builder.Build();

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

app.UseAuthorization();

app.MapControllers();

// Health check -> /api/health behind the proxy.
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.Run();
