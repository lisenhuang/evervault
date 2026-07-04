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

    /// <summary>Server-side OAuth authorization-code exchange for the native app's in-app-browser login:
    /// swaps the <paramref name="code"/> (with the stored, decrypted client secret) for tokens, then
    /// verifies the returned id_token. Returns the verified payload, or null if login is disabled or the
    /// exchange/verification fails. <paramref name="redirectUri"/> must match the one used to start the flow.</summary>
    Task<GoogleJsonWebSignature.Payload?> ExchangeCodeAsync(string code, string redirectUri, CancellationToken ct);
}
