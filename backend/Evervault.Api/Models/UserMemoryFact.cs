namespace Evervault.Api.Models;

/// <summary>
/// One durable, distilled fact about an end-user — the "the AI knows you" layer that sits above the raw
/// <see cref="ChatMemory"/> transcript. Facts are extracted in the browser from conversations (with the
/// user's own Gemini key, like everything else here) and injected wholesale into the system instruction
/// of every chat, so the AI is always grounded in who the user is. Superseded by
/// (<see cref="EndUserId"/>, <see cref="Category"/>, <see cref="Key"/>): re-extracting the same key
/// overwrites the value rather than creating a near-duplicate. Scoped to one <see cref="EndUserId"/>.
/// </summary>
public class UserMemoryFact
{
    public int Id { get; set; }
    public int EndUserId { get; set; }
    // identity | preferences | relationships | work | goals | interests | open_loop | other
    public string Category { get; set; } = "other";
    public string Key { get; set; } = string.Empty;    // short slug, e.g. "name", "employer", "current_project"
    public string Value { get; set; } = string.Empty;  // one-sentence fact
    public int Salience { get; set; } = 3;             // 1..5 importance, for ordering + token-budget trimming
    public string Source { get; set; } = "extracted";  // "extracted" | "user" (reserved for future manual edits)
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
