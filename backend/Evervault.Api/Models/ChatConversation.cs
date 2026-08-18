namespace Evervault.Api.Models;

/// <summary>
/// What the user has decided ABOUT one of their conversations — today, only whether it is pinned.
/// <para>
/// The conversation itself is not a row anywhere and deliberately isn't: it exists as the set of
/// <see cref="ChatTranscript"/> messages sharing a <c>ConversationId</c>, a browser-minted token the
/// client has been tagging every message with since long before this table existed. Deriving the
/// history list from those messages instead of from a table is what makes the list work for
/// conversations held before this feature shipped — and what keeps an older browser tab, which knows
/// nothing about conversations, still able to write a perfectly listable one.
/// </para>
/// <para>
/// So a row here is an overlay, not a record: it exists only once the user has expressed a preference,
/// and its absence is the default rather than a missing conversation. The listing LEFT-JOINs it.
/// </para>
/// <para>
/// Retention is account-level, like the transcript it annotates: rows are removed only when the user
/// deletes the account (see <c>AuthController.DeleteAccount</c>).
/// </para>
/// </summary>
public class ChatConversation
{
    public int Id { get; set; }
    public int EndUserId { get; set; }

    /// <summary>The browser-minted conversation token these preferences apply to. Not a foreign key —
    /// no per-user table in this model has one — and not a guarantee that any message under it still
    /// exists.</summary>
    public string ConversationId { get; set; } = string.Empty;

    /// <summary>Pinned conversations sort above every unpinned one, whatever their last activity.</summary>
    public bool Pinned { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
