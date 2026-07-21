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
    // For a recurring task this is the NEXT occurrence: the browser rolls it forward (see Recurrence).
    public DateOnly? DueDate { get; set; }
    public string? DueTime { get; set; }                 // "HH:mm" 24h wall clock, display only (never used for windowing)
    public string Status { get; set; } = "open";         // open | done | dismissed
    public string Source { get; set; } = "extracted";    // extracted | user | ai
    public string? SourceConversationId { get; set; }    // conversation that produced it, when known
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>
    /// Repeat rule, or null for a one-off task. A tiny civil-calendar token grammar — <c>daily</c>,
    /// <c>weekdays</c>, <c>weekends</c>, <c>weekly:mon,thu</c>, <c>monthly:15</c> — deliberately NOT
    /// RFC-5545 RRULE, which is defined against UTC instants and would drag exactly the timezone math
    /// <see cref="DueDate"/> exists to avoid (and is a large surface for a model to hallucinate into).
    /// <para>
    /// The server never interprets this: the browser owns all date math (it is the only party that
    /// reliably knows the user's wall calendar), rolls <see cref="DueDate"/> to the next occurrence,
    /// and stores the rule here so the roll survives a reload. A recurring task therefore stays
    /// <see cref="Status"/> = "open" forever — one row that keeps moving, never a stream of instance
    /// rows — which is what keeps it on the agenda and out of the duplicate guard in /sync.
    /// </para>
    /// </summary>
    public string? Recurrence { get; set; }

    /// <summary>
    /// When the most recent occurrence of a recurring task was ticked off. Distinct from
    /// <see cref="CompletedAt"/>, which must stay null here: the API sets CompletedAt only alongside
    /// Status = "done", and a previously-shipped client reads a non-null CompletedAt as "this task is
    /// finished" — which a repeating task never is.
    /// </summary>
    public DateTimeOffset? LastCompletedAt { get; set; }
}
