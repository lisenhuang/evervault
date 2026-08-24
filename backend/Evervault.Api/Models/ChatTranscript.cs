namespace Evervault.Api.Models;

/// <summary>
/// One message of an end-user ↔ AI conversation, recorded verbatim as text — the durable record of what
/// was actually said. Every surface lands here: typed messages, voice messages (the transcript of the
/// clip) and realtime calls (the Live transcription of both sides), so a conversation can be replayed as
/// text regardless of how it was held.
/// <para>
/// Deliberately a separate table from <see cref="ChatMemory"/>, which is the <b>recall</b> corpus and
/// cannot double as a record: memories are clipped to 16k, embedded, rolled up into summaries/digests,
/// and removable one-by-one through the forget flow. Splitting them means recording everything faithfully
/// — including replies that errored — without polluting what recall searches. The two are written
/// independently; neither depends on the other.
/// </para>
/// <para>
/// <see cref="Content"/> carries no full-text/trigram expression index on purpose. Those are maintained on
/// INSERT and a tsvector over ~1MB fails the write outright, which is exactly why the memory table has to
/// clip; with no such index here the text can be stored whole.
/// </para>
/// <para>
/// Retention is account-level: rows live as long as the account does. The two things that remove one are
/// the user deleting that message from the chat (<c>DELETE /chat/transcript/{clientMessageId}</c>, so a
/// bubble they removed doesn't come back on the next refresh) and the user deleting the account, which
/// takes everything (see <c>AuthController.DeleteAccount</c>).
/// </para>
/// </summary>
public class ChatTranscript
{
    /// <summary>bigint: this table gets a row per message, not per remembered turn, so it grows far
    /// faster than <see cref="ChatMemory"/> and shouldn't inherit its 32-bit ceiling.</summary>
    public long Id { get; set; }
    public int EndUserId { get; set; }
    public string ConversationId { get; set; } = string.Empty;

    /// <summary>The browser's own id for this message, and the idempotency key: recording is retried
    /// (on failure, and again when the tab is closing), and a streamed reply is re-sent once it settles.
    /// Unique per user, so every one of those writes updates this row instead of appending a duplicate.
    /// </summary>
    public string ClientMessageId { get; set; } = string.Empty;

    public string Role { get; set; } = string.Empty;   // "user" | "assistant"
    public string Modality { get; set; } = "text";     // "text" | "voice" | "live" | "image"

    /// <summary>The message text, verbatim — for voice and live calls, its transcription.</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>When the browser says the message was sent/spoken. Ordering anchor within a conversation:
    /// <see cref="CreatedAt"/> is when we recorded it, which for a reply is when it finished streaming.
    /// Nullable so a client that doesn't send it still records.</summary>
    public DateTimeOffset? ClientCreatedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>Last time this row was rewritten — i.e. when a re-sent message revised its text.</summary>
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
