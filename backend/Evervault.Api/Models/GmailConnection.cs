namespace Evervault.Api.Models;

/// <summary>
/// One end-user's Gmail read-only OAuth grant, connected from inside the chat (there is no
/// standalone UI entry). One row per <see cref="EndUser"/> (unique on <see cref="EndUserId"/>),
/// mirroring <see cref="OpenAiOAuthConfig"/>'s shape but per-user: tokens are held ENCRYPTED
/// (Data Protection, purpose "Evervault.GmailOAuth") and never returned to clients. The row also
/// carries the in-flight PKCE authorization and the background-sync bookkeeping.
/// </summary>
public class GmailConnection
{
    public int Id { get; set; }

    public int EndUserId { get; set; }

    /// <summary>Data Protection ciphertext of the current OAuth access token (cached to avoid
    /// refreshing on every Gmail call).</summary>
    public string AccessTokenEncrypted { get; set; } = string.Empty;

    /// <summary>Data Protection ciphertext of the refresh token. Google refresh tokens don't rotate,
    /// but storage follows the rotation-safe pattern anyway.</summary>
    public string RefreshTokenEncrypted { get; set; } = string.Empty;

    /// <summary>When the current access token expires; refreshed proactively before this.</summary>
    public DateTimeOffset? AccessTokenExpiresAt { get; set; }

    /// <summary>Email of the connected Gmail account (from the id_token). May legitimately differ
    /// from the account the user signs in with; always surfaced so a mismatch is visible.</summary>
    public string? GmailEmail { get; set; }

    /// <summary>Google subject of the connected Gmail account (from the id_token).</summary>
    public string? GmailSub { get; set; }

    /// <summary>The scope string Google actually granted (granular consent lets users untick scopes).</summary>
    public string? GrantedScopes { get; set; }

    /// <summary>When the account was connected. Null = never completed a connect.</summary>
    public DateTimeOffset? ConnectedAt { get; set; }

    /// <summary>"pending" (row created for an in-flight connect, not yet completed), "connected", or
    /// "revoked" (refresh token dead at Google — user must reconnect via chat). CompleteAsync is the
    /// only place that flips a row to "connected"; the read gates and sync require that state.</summary>
    public string Status { get; set; } = "pending";

    // --- In-flight PKCE authorization (cleared once the code is exchanged) ---

    /// <summary>CSRF <c>state</c> for the pending authorization; must match on the callback.</summary>
    public string? PendingState { get; set; }

    /// <summary>PKCE code_verifier for the pending authorization (secret; never leaves the server).</summary>
    public string? PendingCodeVerifier { get; set; }

    /// <summary>When the pending authorization was started; used to reject stale callbacks.</summary>
    public DateTimeOffset? PendingCreatedAt { get; set; }

    // --- Background-sync bookkeeping (see GmailSyncService) ---

    /// <summary>Gmail historyId high-water mark for incremental sync. uint64 at Google — stored as a
    /// string, never used arithmetically.</summary>
    public string? LastHistoryId { get; set; }

    /// <summary>When the last sync attempt finished (stamped on failure too, so retries pace at the
    /// normal interval). Null = due immediately.</summary>
    public DateTimeOffset? LastSyncAt { get; set; }

    /// <summary>Clipped message of the last sync failure; null after a clean pass.</summary>
    public string? LastSyncError { get; set; }

    /// <summary>False until the initial 30-day pull has completed (tools explain "first sync running").</summary>
    public bool InitialSyncDone { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
