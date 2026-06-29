using Google.Apis.Auth;

namespace Evervault.Api.Services;

/// <summary>Google OAuth config returned to the admin UI — the client secret is never included (masked).</summary>
public record GoogleAuthConfigDto(
    string ClientId,
    bool SecretConfigured,
    bool Enabled,
    string? AllowedEmailDomain,
    DateTimeOffset UpdatedAt);

/// <summary>Google OAuth config submitted from the admin UI. ClientSecret is write-only; blank = keep existing.</summary>
public record GoogleAuthConfigInput(
    string ClientId,
    string? ClientSecret,
    bool Enabled,
    string? AllowedEmailDomain);

public interface IGoogleAuthService
{
    Task<GoogleAuthConfigDto?> GetAsync();
    Task SaveAsync(GoogleAuthConfigInput input);

    /// <summary>The configured client id if Google login is enabled, else null (drives the sign-in UI).</summary>
    Task<string?> GetClientIdIfEnabledAsync();

    /// <summary>Validate a Google ID token against the configured client id. Null if disabled or invalid.</summary>
    Task<GoogleJsonWebSignature.Payload?> VerifyIdTokenAsync(string idToken);
}
