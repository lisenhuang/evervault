namespace Evervault.Api.Models;

/// <summary>
/// How the user has recently been doing — "had a brutal week at work", "getting over a cold", "sleeping
/// badly since the move". The thing a friend remembers and asks about next time, which neither of the
/// other two stores can hold: a <see cref="UserMemoryFact"/> is durable by definition (and its extraction
/// prompt is told to ignore transient context), while a <see cref="UserTask"/> is something to DO.
/// <para>
/// Deliberately its own table rather than another <see cref="UserMemoryFact"/> category. Facts are
/// evicted at 80 rows per user by salience then <c>UpdatedAt</c> descending, so a freshly-written state
/// row would outrank every older row on the tiebreak and each extraction would quietly hard-delete the
/// user's oldest durable facts. A mood must never be able to cost someone their profile.
/// </para>
/// <para>
/// Superseded by (<see cref="EndUserId"/>, <see cref="Key"/>): re-extracting the same theme replaces the
/// value, so this stays a small "how are they lately" snapshot rather than a mood log. States also
/// EXPIRE — a fortnight-old bad week is not current, and treating it as current is worse than having
/// forgotten it (see the injection TTL in the web client, and the sweep here).
/// </para>
/// </summary>
public class UserState
{
    public int Id { get; set; }
    public int EndUserId { get; set; }
    /// <summary>Short stable theme slug — "work", "health", "sleep", "mood" — NOT one row per remark.</summary>
    public string Key { get; set; } = string.Empty;
    /// <summary>
    /// One sentence, phrased as something the user SAID about themselves ("Mentioned they'd had a
    /// rough week at work"), never as a conclusion drawn about them. The qualification lives in the
    /// stored text rather than only in the renderer, so it travels with the data wherever it is read.
    /// </summary>
    public string Value { get; set; } = string.Empty;
    /// <summary>Civil date the user said it, resolved in the browser — so the assistant can say "last
    /// week" correctly, and so staleness is judged on the user's wall calendar rather than UTC.</summary>
    public DateOnly? NotedOn { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
