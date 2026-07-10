namespace Evervault.Api.Models;

/// <summary>
/// "Sign in with ChatGPT" (Codex OAuth) connection for the admin chat's third provider. Single-row
/// table (Id = 1), mirroring <see cref="GoogleAuthConfig"/>: the access/refresh tokens are held
/// ENCRYPTED (Data Protection), never plaintext, and never returned to the UI. Unlike the key-based
/// providers there is exactly one connected ChatGPT account, so this is a config row, not an
/// <see cref="AiKey"/> list.
/// </summary>
public class OpenAiOAuthConfig
{
    public int Id { get; set; }

    /// <summary>Data Protection ciphertext of the OAuth access token (bearer for the ChatGPT backend).</summary>
    public string AccessTokenEncrypted { get; set; } = string.Empty;

    /// <summary>Data Protection ciphertext of the refresh token. Rotates on every refresh.</summary>
    public string RefreshTokenEncrypted { get; set; } = string.Empty;

    /// <summary>ChatGPT account id (from the id_token) sent as the <c>chatgpt-account-id</c> header.</summary>
    public string AccountId { get; set; } = string.Empty;

    /// <summary>When the current access token expires. We refresh proactively before this.</summary>
    public DateTimeOffset? AccessTokenExpiresAt { get; set; }

    /// <summary>Email of the connected account (from the id_token), shown in the UI. Not a secret.</summary>
    public string? ConnectedEmail { get; set; }

    /// <summary>When the account was connected. Null = not connected.</summary>
    public DateTimeOffset? ConnectedAt { get; set; }

    // --- In-flight PKCE authorization (cleared once the code is exchanged) ---

    /// <summary>CSRF <c>state</c> for the pending authorization; must match on completion.</summary>
    public string? PendingState { get; set; }

    /// <summary>PKCE code_verifier for the pending authorization (secret; never returned to the UI).</summary>
    public string? PendingCodeVerifier { get; set; }

    /// <summary>When the pending authorization was started; used to reject stale exchanges.</summary>
    public DateTimeOffset? PendingCreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
