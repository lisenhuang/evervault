using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Data;

/// <summary>
/// Builds the ANN indexes for the two embedded tables — <c>ChatMemories</c> (recall) and <c>ChatFiles</c>
/// (file search). The embedding dimension is chosen by the admin at runtime
/// (<see cref="Models.EmbeddingConfig"/>), so it can't live in a static EF migration — an HNSW index
/// requires a fixed dimension. This runs after migrations on startup, and again whenever the admin
/// locks the dimension. It:
/// <list type="number">
/// <item>backfills <c>EmbeddingHalf</c> from any legacy full-precision <c>Embedding</c> values;</item>
/// <item>pins each <c>halfvec</c> column to the locked dimension (needed before it can be indexed);</item>
/// <item>creates the HNSW cosine indexes.</item>
/// </list>
/// Idempotent and best-effort: any failure is logged and never blocks startup or the request.
/// </summary>
public static class ChatMemoryVectorIndex
{
    private const string IndexName = "IX_ChatMemories_EmbeddingHalf_hnsw";
    private const string FilesIndexName = "IX_ChatFiles_EmbeddingHalf_hnsw";

    public static async Task EnsureAsync(AppDbContext db, ILogger? logger = null, CancellationToken ct = default)
    {
        try
        {
            var cfg = await db.EmbeddingConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
            if (cfg is null || cfg.LockedAt is null) return;   // dimension not locked yet — nothing to index
            var dim = cfg.Dimensions;
            if (dim is not (768 or 1536 or 3072)) return;      // only the dimensions the admin UI allows

            // Copy any legacy vectors into the halfvec column (cheap no-op once nothing is pending). Kept
            // unconditional so rows written by the previous version during rollout get picked up on restart.
            await db.Database.ExecuteSqlRawAsync(
                "UPDATE \"ChatMemories\" SET \"EmbeddingHalf\" = \"Embedding\"::halfvec " +
                "WHERE \"Embedding\" IS NOT NULL AND \"EmbeddingHalf\" IS NULL;", ct);

            // Pin the column to the locked dimension (needed before it can be HNSW-indexed) and build the
            // cosine index — but only once, guarded on the index not already existing so we don't re-run the
            // table-rewriting ALTER on every startup. `dim` is validated above, so string-building is safe.
            // Every stored vector shares the one locked dimension (the write path rejects mismatches), so the
            // ALTER validates cleanly.
            await db.Database.ExecuteSqlRawAsync(
                $"""
                 DO $$
                 BEGIN
                     IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'i' AND relname = '{IndexName}') THEN
                         ALTER TABLE "ChatMemories" ALTER COLUMN "EmbeddingHalf"
                             TYPE halfvec({dim}) USING "EmbeddingHalf"::halfvec({dim});
                         CREATE INDEX "{IndexName}" ON "ChatMemories"
                             USING hnsw ("EmbeddingHalf" halfvec_cosine_ops);
                     END IF;
                 END $$;
                 """, ct);

            // Same treatment for ChatFiles.EmbeddingHalf (the find_files vector lane). No backfill step —
            // this table never had a full-precision column to copy from.
            await db.Database.ExecuteSqlRawAsync(
                $"""
                 DO $$
                 BEGIN
                     IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'i' AND relname = '{FilesIndexName}') THEN
                         ALTER TABLE "ChatFiles" ALTER COLUMN "EmbeddingHalf"
                             TYPE halfvec({dim}) USING "EmbeddingHalf"::halfvec({dim});
                         CREATE INDEX "{FilesIndexName}" ON "ChatFiles"
                             USING hnsw ("EmbeddingHalf" halfvec_cosine_ops);
                     END IF;
                 END $$;
                 """, ct);

            logger?.LogInformation("Chat-memory and chat-file HNSW indexes ensured (halfvec, dim {Dim}).", dim);
        }
        catch (Exception ex)
        {
            logger?.LogWarning("Chat-memory/chat-file vector indexes not ensured: {Message}", ex.Message);
        }
    }
}
