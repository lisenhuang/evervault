using System.Net;
using System.Text.Json;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services.Ai;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Loads/saves the Brave Search API key in the DB (encrypted with Data Protection) and runs live web
/// searches with it. No env vars / no secrets on disk — the key is configured from the /admin UI and
/// never leaves the backend. Single-row table (mirrors <see cref="GoogleAuthService"/> /
/// <see cref="StorageService"/>). Upstream errors are mapped to <see cref="AiProviderException"/> so the
/// calling controller can reuse the same friendly EV-code handling the AI proxy uses.
/// </summary>
public class BraveSearchService : IBraveSearchService
{
    /// <summary>Named HttpClient (registered in Program.cs) for the Brave Search REST call.</summary>
    public const string HttpClientName = "brave-search";

    private const string Base = "https://api.search.brave.com";

    private readonly AppDbContext _db;
    private readonly IHttpClientFactory _http;
    private readonly IDataProtector _protector;

    public BraveSearchService(AppDbContext db, IHttpClientFactory http, IDataProtectionProvider dp)
    {
        _db = db;
        _http = http;
        // Unique purpose string — part of the derived key, must not collide with another secret's protector.
        _protector = dp.CreateProtector("Evervault.BraveSearchKey");
    }

    public async Task<BraveSearchConfigDto?> GetAsync()
    {
        var c = await _db.BraveSearchConfigs.AsNoTracking().FirstOrDefaultAsync();
        if (c is null) return null;
        return new BraveSearchConfigDto(!string.IsNullOrEmpty(c.ApiKeyEncrypted), c.KeyHint, c.UpdatedAt);
    }

    public async Task SaveAsync(BraveSearchConfigInput input)
    {
        var existing = await _db.BraveSearchConfigs.FirstOrDefaultAsync();
        var c = existing ?? new BraveSearchConfig();

        // Write-only: a blank submission keeps the stored key (the UI shows a masked placeholder).
        var key = input.ApiKey?.Trim();
        if (!string.IsNullOrWhiteSpace(key))
        {
            c.ApiKeyEncrypted = _protector.Protect(key);
            c.KeyHint = Hint(key);
        }
        c.UpdatedAt = DateTimeOffset.UtcNow;

        if (existing is null) _db.BraveSearchConfigs.Add(c);
        await _db.SaveChangesAsync();
    }

    public async Task<bool> IsConfiguredAsync()
    {
        var c = await _db.BraveSearchConfigs.AsNoTracking().FirstOrDefaultAsync();
        return c is not null && !string.IsNullOrEmpty(c.ApiKeyEncrypted);
    }

    public async Task<IReadOnlyList<WebSearchResult>> SearchAsync(string query, int count, CancellationToken ct)
    {
        query = (query ?? "").Trim();
        if (query.Length == 0) return Array.Empty<WebSearchResult>();
        count = Math.Clamp(count, 1, 10);

        var key = await GetRawKeyAsync();
        if (key is null)
            // Mirror KeyFailoverRunner's "no keys" convention: model "not configured" as an Auth error so
            // the controller can turn it into a soft "web search isn't set up" response.
            throw new AiProviderException(AiErrorKind.Auth,
                "No Brave Search API key is configured. Add one in the admin web-search settings.");

        var client = _http.CreateClient(HttpClientName);
        var url = $"{Base}/res/v1/web/search?q={Uri.EscapeDataString(query)}&count={count}";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        // Key in a header, never the URL, so it can't leak into request logs.
        req.Headers.TryAddWithoutValidation("X-Subscription-Token", key);
        req.Headers.TryAddWithoutValidation("Accept", "application/json");

        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        return Parse(body, count);
    }

    private async Task<string?> GetRawKeyAsync()
    {
        var c = await _db.BraveSearchConfigs.AsNoTracking().FirstOrDefaultAsync();
        if (c is null || string.IsNullOrEmpty(c.ApiKeyEncrypted)) return null;
        try { return _protector.Unprotect(c.ApiKeyEncrypted); }
        catch { return null; } // undecryptable (rotated keyring) — treated as "not configured"
    }

    // Parse Brave's { web: { results: [ { title, url, description } ] } } into the compact shape the
    // assistant answers from. Missing/oddly-shaped fields are skipped, never thrown on.
    private static IReadOnlyList<WebSearchResult> Parse(string body, int count)
    {
        var results = new List<WebSearchResult>();
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("web", out var web)
                && web.TryGetProperty("results", out var arr)
                && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in arr.EnumerateArray())
                {
                    var title = Str(r, "title");
                    var link = Str(r, "url");
                    if (link.Length == 0) continue;
                    results.Add(new WebSearchResult(title, link, Str(r, "description")));
                    if (results.Count >= count) break;
                }
            }
        }
        catch (JsonException) { /* upstream returned non-JSON on a 2xx — treat as no results */ }
        return results;
    }

    private static string Str(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    // Same status→kind mapping the AI providers use, so web-search failures classify consistently.
    private static AiProviderException MapError(HttpStatusCode status, string body)
    {
        var head = $"HTTP {(int)status} {status}";
        var raw = string.IsNullOrWhiteSpace(body)
            ? "(empty response body)"
            : (body.Trim().Length > 2000 ? body.Trim()[..2000] + "…(truncated)" : body.Trim());
        var message = $"{head}. Raw response: {raw}";

        var kind = (int)status switch
        {
            401 or 403 => AiErrorKind.Auth,
            429 => AiErrorKind.Quota,
            >= 500 => AiErrorKind.Transient,
            _ => AiErrorKind.Other,
        };
        return new AiProviderException(kind, message);
    }

    // Masked preview for the admin UI: first 3 + last 4 chars, middle elided. Never the raw key.
    private static string Hint(string key)
    {
        key = key.Trim();
        if (key.Length <= 7) return new string('•', Math.Max(key.Length, 1));
        return $"{key[..3]}…{key[^4..]}";
    }
}
