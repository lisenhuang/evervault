using Pgvector;

namespace Evervault.Api.Models;

/// <summary>
/// One recorded turn of an end-user ↔ AI conversation, for recall. Raw <see cref="Content"/> (text /
/// transcript / image description) is always stored; push-to-talk audio and attached images are stored
/// in R2 and referenced by <see cref="AudioObjectKey"/> / <see cref="ImageObjectKey"/>.
/// <see cref="EmbeddingHalf"/> is computed in the browser with the user's own Gemini key; it is stored as
/// a half-precision <c>halfvec</c> (≈half the disk of a <c>vector</c>, negligible recall loss) and is the
/// column recall searches — backed by an HNSW cosine index built once the admin locks the dimension. It is
/// null until/unless embedded. <see cref="Embedding"/> is the legacy full-precision <c>vector</c> column,
/// kept and dual-written for one release so the previously-deployed version keeps working during rollout;
/// a later migration drops it. Scoped to one <see cref="EndUserId"/>.
/// </summary>
public class ChatMemory
{
    public int Id { get; set; }
    public int EndUserId { get; set; }
    public string ConversationId { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;   // "user" | "assistant"
    public string Modality { get; set; } = "text";      // "text" | "voice" | "live" | "image"
    public string Kind { get; set; } = "turn";          // "turn" (a recorded message) | "summary" (one per conversation)
    public string Content { get; set; } = string.Empty;
    public string? AudioObjectKey { get; set; }
    public string? ImageObjectKey { get; set; }
    public Vector? Embedding { get; set; }          // legacy full-precision column (kept for rollout compat)
    public HalfVector? EmbeddingHalf { get; set; }  // half-precision; the searched column + HNSW-indexed
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
