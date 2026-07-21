namespace Evervault.Api.Models;

/// <summary>
/// Something happening IN the user's life on a given day — a job interview, a friend's wedding, a scan
/// result, a flight. The thing that makes "how did the interview go?" possible, which none of the other
/// stores can express:
/// <list type="bullet">
/// <item>A <see cref="UserTask"/> is something the user must DO, and passive extraction is forbidden
/// from creating one (a task only lands on the list when the human confirms it). An event is not a
/// to-do and must never render as one.</item>
/// <item>A <see cref="UserMemoryFact"/> is durable; an event is defined by expiring.</item>
/// <item>A <see cref="UserState"/> is how they've been feeling, not a dated occurrence.</item>
/// </list>
/// <para>
/// The lifecycle is what makes it useful and is the reverse of a task's: an event happens whether or not
/// the user does anything, and the assistant's job is to NOTICE the date passed and ask once.
/// <see cref="FollowedUpAt"/> is what stops it asking twice.
/// </para>
/// <para>
/// <see cref="EventDate"/> is a civil (wall-calendar) date resolved in the browser, for the same reason
/// <see cref="UserTask.DueDate"/> is: "Friday" must mean Friday wherever the user happens to be.
/// </para>
/// </summary>
public class UserLifeEvent
{
    public int Id { get; set; }
    public int EndUserId { get; set; }
    /// <summary>Short description in the user's own language, e.g. "Job interview at Acme".</summary>
    public string Title { get; set; } = string.Empty;
    public string? Details { get; set; }
    /// <summary>The civil day it happens/happened. Null means "they mentioned it but gave no date".</summary>
    public DateOnly? EventDate { get; set; }
    /// <summary>open | closed. Closed once it's been asked about and there's nothing more to follow.</summary>
    public string Status { get; set; } = "open";
    /// <summary>Set the first time the assistant asked how it went, so it never asks a second time.</summary>
    public DateTimeOffset? FollowedUpAt { get; set; }
    public string? SourceConversationId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
