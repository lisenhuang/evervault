namespace Evervault.Api.Models;

/// <summary>
/// One structured to-do for an end-user — the thing that makes "what do I need to do today?" reliable.
/// Unlike a <see cref="ChatMemory"/> turn (indexed by when it was *said*) or a free-text open_loop
/// <see cref="UserMemoryFact"/>, a task carries an explicit <see cref="DueDate"/>, so an agenda ("due
/// today + overdue") is a deterministic query rather than a semantic guess. Tasks are extracted in the
/// browser from conversations (the user's own Gemini key, like everything else here) or created via the
/// in-chat task tools; the server only stores and serves them. Scoped to one <see cref="EndUserId"/>.
/// </summary>
public class UserTask
{
    public int Id { get; set; }
    public int EndUserId { get; set; }
    public string Title { get; set; } = string.Empty;   // short imperative, in the user's own language
    public string? Details { get; set; }                 // optional extra context
    // Civil (wall-calendar) due date, resolved in the browser from the user's local timezone and stored
    // as a plain date. Date-only so "Friday" means Friday wherever the user is — no UTC/DST/travel skew.
    // Recurrence is deferred: a recurring commitment stays an open_loop UserMemoryFact for now.
    public DateOnly? DueDate { get; set; }
    public string? DueTime { get; set; }                 // "HH:mm" 24h wall clock, display only (never used for windowing)
    public string Status { get; set; } = "open";         // open | done | dismissed
    public string Source { get; set; } = "extracted";    // extracted | user | ai
    public string? SourceConversationId { get; set; }    // conversation that produced it, when known
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
}
