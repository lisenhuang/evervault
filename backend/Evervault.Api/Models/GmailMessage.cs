namespace Evervault.Api.Models;

/// <summary>
/// A local copy of one Gmail message for a connected end-user, written by the background sync
/// (30-day retention). Headers + extracted plain text only — never attachments, never raw MIME.
/// Stored plaintext (like <see cref="ChatMemory"/>) because the in-chat email search runs in SQL;
/// only the OAuth tokens themselves are encrypted. Deleted wholesale on disconnect/account delete.
/// </summary>
public class GmailMessage
{
    public int Id { get; set; }

    public int EndUserId { get; set; }

    /// <summary>Gmail's message id; unique per user, the upsert anchor for idempotent sync passes.</summary>
    public string GmailId { get; set; } = string.Empty;

    public string ThreadId { get; set; } = string.Empty;

    /// <summary>Sender address parsed from the From header.</summary>
    public string FromAddr { get; set; } = string.Empty;

    /// <summary>Sender display name from the From header (may be empty).</summary>
    public string FromName { get; set; } = string.Empty;

    /// <summary>The To header, clipped — context only, not parsed further.</summary>
    public string ToAddr { get; set; } = string.Empty;

    public string Subject { get; set; } = string.Empty;

    /// <summary>Gmail's own short preview snippet, HTML-entity-decoded.</summary>
    public string Snippet { get; set; } = string.Empty;

    /// <summary>Extracted plain-text body (text/plain part, else tag-stripped HTML), capped at ingest.</summary>
    public string BodyText { get; set; } = string.Empty;

    /// <summary>Gmail internalDate (when the message was received) — the retention/ordering key.</summary>
    public DateTimeOffset InternalDate { get; set; }

    // Label-derived flags, refreshed on incremental sync so the digest stays honest.
    public bool IsUnread { get; set; }
    public bool IsImportant { get; set; }
    public bool IsStarred { get; set; }

    /// <summary>First CATEGORY_* label (PERSONAL/UPDATES/PROMOTIONS/SOCIAL/FORUMS), or null.</summary>
    public string? Category { get; set; }

    /// <summary>Last time the sync engine wrote this row.</summary>
    public DateTimeOffset SyncedAt { get; set; } = DateTimeOffset.UtcNow;
}
