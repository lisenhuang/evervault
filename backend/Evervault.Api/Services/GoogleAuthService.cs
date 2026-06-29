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

    public GoogleAuthService(AppDbContext db, IDataProtectionProvider dp)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.GoogleAuthSecret");
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
}
