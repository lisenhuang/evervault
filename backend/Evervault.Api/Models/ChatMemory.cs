using Pgvector;

namespace Evervault.Api.Models;

/// <summary>
/// One recorded turn of an end-user ↔ AI conversation, for recall. Raw <see cref="Content"/> (text /
/// transcript) is always stored; push-to-talk audio is stored in R2 and referenced by
/// <see cref="AudioObjectKey"/>. <see cref="Embedding"/> is computed in the browser with the user's own
/// Gemini key (the column is a dimensionless <c>vector</c> so the admin can pick the dimension); it is
/// null until/unless embedded. Scoped to one <see cref="EndUserId"/>.
/// </summary>
public class ChatMemory
{
    public int Id { get; set; }
    public int EndUserId { get; set; }
    public string ConversationId { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;   // "user" | "assistant"
    public string Modality { get; set; } = "text";      // "text" | "voice" | "live"
    public string Kind { get; set; } = "turn";          // "turn" (a recorded message) | "summary" (one per conversation)
    public string Content { get; set; } = string.Empty;
    public string? AudioObjectKey { get; set; }
    public Vector? Embedding { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
