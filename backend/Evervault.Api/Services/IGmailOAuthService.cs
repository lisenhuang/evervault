namespace Evervault.Api.Services;

/// <summary>Per-user Gmail connection status, safe for the webapp UI and the AI status line (no secrets).</summary>
public record GmailStatusDto(
    bool Available,
    bool Connected,
    string? Email,
    DateTimeOffset? ConnectedAt,
    bool InitialSyncDone,
    DateTimeOffset? LastSyncAt,
    bool NeedsReconnect);

/// <summary>Outcome of the OAuth callback exchange. <see cref="ErrorKind"/> is a stable machine key
/// the controller maps to a static user-facing string (never reflected input): "denied",
/// "no_pending", "expired", "state_mismatch", "scope_missing", "no_refresh_token", "exchange_failed".</summary>
public record GmailConnectResult(bool Ok, string? Email, string? ErrorKind);

/// <summary>
/// Manages per-end-user Gmail read-only OAuth grants: builds the PKCE authorize URL, completes the
/// code exchange on the callback, refreshes access tokens, and revokes on disconnect. Reuses the
/// admin-configured Google OAuth client (<see cref="Models.GoogleAuthConfig"/>). Raw tokens are
/// encrypted with Data Protection and never returned to callers.
/// </summary>
public interface IGmailOAuthService
{
    /// <summary>Whether the Gmail connect feature can work at all: Google auth enabled, client id
    /// present, and the client secret configured (the ID-token sign-in never needed it; this does).</summary>
    Task<bool> IsAvailableAsync(CancellationToken ct);

    /// <summary>Start a connect for one user: generate PKCE + state on their row and return the
    /// Google authorize URL for the popup. Throws if the feature is unavailable.</summary>
    Task<string> BuildAuthorizeUrlAsync(int endUserId, string redirectUri, string? loginHint, CancellationToken ct);

    /// <summary>Complete the callback for one user: validate state/TTL, exchange the code, verify the
    /// Gmail scope was actually granted, and store the tokens. Never throws for flow-level failures —
    /// they come back as <see cref="GmailConnectResult.ErrorKind"/> for the callback page.</summary>
    Task<GmailConnectResult> CompleteAsync(int endUserId, string code, string state, string redirectUri, CancellationToken ct);

    Task<GmailStatusDto> GetStatusAsync(int endUserId, CancellationToken ct);

    /// <summary>A currently-valid access token for the user (refreshing proactively when near expiry),
    /// or "" when not connected / revoked / refresh failed. An invalid_grant marks the row revoked.</summary>
    Task<string> TryGetValidAccessTokenAsync(int endUserId, CancellationToken ct);

    /// <summary>Force a refresh (after a Gmail 401), returning the new token or "" on failure.</summary>
    Task<string> ForceRefreshAsync(int endUserId, CancellationToken ct);

    /// <summary>Best-effort revoke at Google, then delete the connection row AND the user's synced
    /// messages — disconnect means "stop holding my mail".</summary>
    Task DisconnectAsync(int endUserId, CancellationToken ct);
}
