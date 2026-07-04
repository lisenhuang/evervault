using System.Text.Json;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Google.Apis.Auth;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Loads/saves the Google OAuth config in the DB (client secret encrypted with Data Protection) and
/// verifies Google ID tokens. No env vars / no secrets on disk — everything is configured from the
/// /admin UI. Single-row table (mirrors <see cref="StorageService"/>).
/// </summary>
public class GoogleAuthService : IGoogleAuthService
{
    private readonly AppDbContext _db;
    private readonly IDataProtector _protector;
    private readonly IHttpClientFactory _http;

    public GoogleAuthService(AppDbContext db, IDataProtectionProvider dp, IHttpClientFactory http)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.GoogleAuthSecret");
        _http = http;
    }

    public async Task<GoogleAuthConfigDto?> GetAsync()
    {
        var c = await _db.GoogleAuthConfigs.AsNoTracking().FirstOrDefaultAsync();
        if (c is null) return null;
        return new GoogleAuthConfigDto(
            c.ClientId, !string.IsNullOrEmpty(c.ClientSecretEncrypted), c.Enabled, c.AllowedEmailDomain, c.UpdatedAt);
    }

    public async Task SaveAsync(GoogleAuthConfigInput input)
    {
        var existing = await _db.GoogleAuthConfigs.FirstOrDefaultAsync();
        var c = existing ?? new GoogleAuthConfig();

        c.ClientId = (input.ClientId ?? "").Trim();
        c.Enabled = input.Enabled;
        c.AllowedEmailDomain = string.IsNullOrWhiteSpace(input.AllowedEmailDomain)
            ? null
            : input.AllowedEmailDomain!.Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(input.ClientSecret))
            c.ClientSecretEncrypted = _protector.Protect(input.ClientSecret);
        c.UpdatedAt = DateTimeOffset.UtcNow;

        if (existing is null) _db.GoogleAuthConfigs.Add(c);
        await _db.SaveChangesAsync();
    }

    public async Task<string?> GetClientIdIfEnabledAsync()
    {
        var c = await _db.GoogleAuthConfigs.AsNoTracking().FirstOrDefaultAsync();
        return c is { Enabled: true } && !string.IsNullOrWhiteSpace(c.ClientId) ? c.ClientId : null;
    }

    public async Task<GoogleJsonWebSignature.Payload?> VerifyIdTokenAsync(string idToken)
    {
        if (string.IsNullOrWhiteSpace(idToken)) return null;

        var c = await _db.GoogleAuthConfigs.AsNoTracking().FirstOrDefaultAsync();
        if (c is null || !c.Enabled || string.IsNullOrWhiteSpace(c.ClientId)) return null;

        var settings = new GoogleJsonWebSignature.ValidationSettings
        {
            Audience = new[] { c.ClientId },
            HostedDomain = string.IsNullOrWhiteSpace(c.AllowedEmailDomain) ? null : c.AllowedEmailDomain,
        };

        try
        {
            return await GoogleJsonWebSignature.ValidateAsync(idToken, settings);
        }
        catch (InvalidJwtException)
        {
            return null;
        }
    }

    public async Task<GoogleJsonWebSignature.Payload?> ExchangeCodeAsync(string code, string redirectUri, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;

        var c = await _db.GoogleAuthConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
        if (c is null || !c.Enabled || string.IsNullOrWhiteSpace(c.ClientId) || string.IsNullOrEmpty(c.ClientSecretEncrypted))
            return null;

        string clientSecret;
        try { clientSecret = _protector.Unprotect(c.ClientSecretEncrypted); }
        catch { return null; }

        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["code"] = code,
            ["client_id"] = c.ClientId,
            ["client_secret"] = clientSecret,
            ["redirect_uri"] = redirectUri,
            ["grant_type"] = "authorization_code",
        });

        var client = _http.CreateClient();
        using var res = await client.PostAsync("https://oauth2.googleapis.com/token", form, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) return null;

        string? idToken;
        try
        {
            using var doc = JsonDocument.Parse(body);
            idToken = doc.RootElement.TryGetProperty("id_token", out var t) ? t.GetString() : null;
        }
        catch { return null; }

        return string.IsNullOrWhiteSpace(idToken) ? null : await VerifyIdTokenAsync(idToken);
    }
}
