using Pgvector;

namespace Evervault.Api.Models;

/// <summary>
/// One file the end-user attached in a /webapp chat (image / PDF / audio / document), kept permanently so
/// the AI can find it again and hand it back. The bytes live in R2 under <see cref="ObjectKey"/>;
/// <see cref="Description"/> is the AI-generated text that stands in for the file when searching (caption /
/// transcript / doc summary / extracted text) and is what the hybrid find_files lanes match on.
/// <see cref="EmbeddingHalf"/> is computed in the browser with the user's own key and stored as a
/// half-precision <c>halfvec</c> — the same column shape recall uses, HNSW-indexed once the admin locks the
/// dimension. There is no legacy full-precision column here: <see cref="ChatMemory"/> dual-writes only so a
/// previously-deployed reader keeps working during rollout, and a brand-new table has no such reader.
/// <see cref="Sha256"/> is the dedupe key (per user, paired with the file name) so re-sending the same
/// attachment doesn't re-upload it. Scoped to one <see cref="EndUserId"/>; removed only when the user
/// deletes the file or their account.
/// </summary>
public class ChatFile
{
    public int Id { get; set; }
    public int EndUserId { get; set; }
    public string ConversationId { get; set; } = string.Empty;

    /// <summary>The browser's id for the message this file was attached to, when it is known — the same
    /// key <see cref="ChatTranscript.ClientMessageId"/> uses, which is what lets a reopened conversation
    /// put each attachment back on the message that carried it.
    /// <para>
    /// Nullable, and often null: every file stored before this column existed has none, and a file
    /// deduped onto an earlier upload keeps the link it already had. Callers must treat "no link" as the
    /// normal case and fall back rather than hiding the file.
    /// </para></summary>
    public string? ClientMessageId { get; set; }
    public string FileName { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;        // "image" | "pdf" | "audio" | "text"
    public string Mime { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string ObjectKey { get; set; } = string.Empty;
    public string? Sha256 { get; set; }
    public string Description { get; set; } = string.Empty; // caption / transcript / summary / extracted text
    public HalfVector? EmbeddingHalf { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
