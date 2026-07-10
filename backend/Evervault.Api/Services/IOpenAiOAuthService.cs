namespace Evervault.Api.Services;

/// <summary>Connection status of the "Sign in with ChatGPT" account, safe for the UI (no secrets).</summary>
public record OpenAiOAuthStatusDto(
    bool Connected,
    string? Email,
    DateTimeOffset? ConnectedAt,
    DateTimeOffset? ExpiresAt);

/// <summary>Manages the single connected ChatGPT (Codex OAuth) account: builds the PKCE authorize URL,
/// completes the code exchange, refreshes the (rotating) access token, and reports status. The raw
/// tokens are encrypted with Data Protection and never returned to callers.</summary>
public interface IOpenAiOAuthService
{
    /// <summary>Start a login: generate PKCE + state, persist them, and return the authorize URL to open.</summary>
    Task<string> BuildAuthorizeUrlAsync(CancellationToken ct);

    /// <summary>Complete a login from the pasted redirect URL (or raw querystring). Validates state,
    /// exchanges the code, stores tokens, and returns the new status. Throws on any failure.</summary>
    Task<OpenAiOAuthStatusDto> CompleteAsync(string redirectUrlOrCode, CancellationToken ct);

    Task<OpenAiOAuthStatusDto> GetStatusAsync(CancellationToken ct);

    Task DisconnectAsync(CancellationToken ct);

    /// <summary>A currently-valid access token (refreshing proactively if near expiry), or "" when no
    /// account is connected. Never throws for the "not connected" case — the provider surfaces that.</summary>
    Task<string> TryGetValidAccessTokenAsync(CancellationToken ct);

    /// <summary>The account id sent as the <c>chatgpt-account-id</c> header, or "" when not connected.</summary>
    Task<string> GetAccountIdAsync(CancellationToken ct);

    /// <summary>Force a token refresh (used after a 401), returning the new access token or "" on failure.</summary>
    Task<string> ForceRefreshAsync(CancellationToken ct);
}
