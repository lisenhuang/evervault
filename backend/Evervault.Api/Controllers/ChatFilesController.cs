using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Pgvector;
using Pgvector.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Durable storage for the files an end-user attaches in a /webapp chat (image / PDF / audio / document),
/// so the AI can find them again later and hand them back. The bytes go to R2; the row keeps the
/// AI-generated <see cref="ChatFile.Description"/> (caption / transcript / summary / extracted text) plus a
/// client-computed embedding, and that description is what search matches on — the server NEVER embeds.
/// Search is the same hybrid RRF as chat recall (vector + full-text + trigram), with the trigram lane also
/// covering the file name so "report_q3.pdf" is findable by name. Everything here is scoped to the
/// signed-in end-user (UserCookie); files are permanent until the user deletes the file or their account.
/// </summary>
[ApiController]
[Route("chat/files")]   // behind UsePathBase("/api") → /api/chat/files
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatFilesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IStorageService _storage;
    private readonly ILogger<ChatFilesController> _log;

    public ChatFilesController(AppDbContext db, IStorageService storage, ILogger<ChatFilesController> log)
    {
        _db = db;
        _storage = storage;
        _log = log;
    }

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    /// <summary>Pack a client-sent float embedding into a half-precision vector for storage/search.</summary>
    private static HalfVector ToHalf(float[] v) => new(Array.ConvertAll(v, f => (Half)f));

    // A turn carries at most 9 attachments, so a normal session is nowhere near this; the cap only stops a
    // runaway retry loop (or abuse) from filling the bucket.
    private const int MaxPerUserPerHour = 200;
    // Hard ceiling on the decoded payload, below the 25 MB request limit (base64 inflates by ~4/3).
    private const int MaxBytes = 20 * 1024 * 1024;

    private static readonly HashSet<string> Kinds =
        new(StringComparer.OrdinalIgnoreCase) { "image", "pdf", "audio", "text" };

    // The image types the composer can actually produce — isAcceptedImage (web lib/image.ts) is exactly
    // this set, and prepareImage re-encodes anything large to JPEG. Note SVG is absent by design: it
    // reaches us as kind "text" (it's in the composer's TextMimes), so it is stored and served as inert
    // text rather than as an image an R2 presigned GET would hand back as active content.
    private static readonly HashSet<string> AllowedImageMimes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/heic", "image/heif",
    };

    /// <summary>
    /// Whether we accept this attachment, keyed off the already-validated <paramref name="kind"/> rather
    /// than the browser's MIME guess. An earlier enumerate-every-MIME version silently 400'd files the
    /// composer had happily accepted — Safari reports .m4a as <c>audio/x-m4a</c>, Chrome reports .ts as
    /// <c>video/mp2t</c>, Windows reports .csv as <c>application/vnd.ms-excel</c> — and because
    /// uploadChatFile swallows the error, the file just never got stored while the persona kept promising
    /// the AI could retrieve it. Kind is the trustworthy axis: the client derived it from a closed set of
    /// rules, and the payload is stored the same way regardless of what the browser called it.
    /// </summary>
    private static bool MimeAllowed(string kind, string mime) => kind switch
    {
        "image" => AllowedImageMimes.Contains(mime),
        "pdf" => mime.Equals("application/pdf", StringComparison.OrdinalIgnoreCase),
        "audio" => mime.StartsWith("audio/", StringComparison.OrdinalIgnoreCase),
        // Kind "text" is extracted plain text by the time it reaches us (the original bytes never left the
        // browser), so the source MIME is only a label — accept the whole long tail of source/markup types.
        _ => true,
    };

    /// <summary>Content type the object is STORED with. Kind "text" is always inert plain text: the body is
    /// UTF-8 extracted text, and storing the original label (text/html, image/svg+xml, …) would make a
    /// presigned R2 GET serve it as active content.</summary>
    private static string StoredContentType(string kind, string mime) =>
        kind == "text" ? "text/plain; charset=utf-8" : mime;

    public record UploadRequest(string? ConversationId, string FileName, string Kind, string Mime,
                                long SizeBytes, string? Base64, string? Text, string? Description, float[]? Embedding);
    // Score is the fused hybrid-search relevance (higher = better); null on the pure-vector, newest-first,
    // and fallback paths — same shape as MemoryHit.
    public record FileHit(int Id, string FileName, string Kind, string Mime, long SizeBytes,
                          string Description, DateTimeOffset CreatedAt, double? Distance, double? Score = null);
    public record FileData(int Id, string FileName, string Kind, string Mime, long SizeBytes,
                           string? Base64, string? Text);
    public record FileSearchRequest(float[]? Vector, string? Q, int K = 8, string? Kind = null,
                                    DateTimeOffset? Since = null, DateTimeOffset? Until = null);

    /// <summary>Store one attachment permanently: row first (for the id), then the bytes to R2 under
    /// <c>chat-files/{uid}/{id}/{name}</c>. Re-sending the identical file is deduped to the existing row.</summary>
    [HttpPost]
    [RequestSizeLimit(25_000_000)]   // 20 MB of bytes, base64-inflated, plus the description/embedding
    public async Task<IActionResult> Upload([FromBody] UploadRequest req, CancellationToken ct)
    {
        var kind = (req.Kind ?? "").Trim().ToLowerInvariant();
        if (!Kinds.Contains(kind)) return BadRequest(new { error = "Unsupported file kind." });

        var mime = (req.Mime ?? "").Trim();
        if (mime.Length == 0 || !MimeAllowed(kind, mime)) return BadRequest(new { error = "Unsupported file type." });

        // Bytes come from Base64 normally; for kind "text" the original file never left the browser — the
        // extracted text IS what we keep, so store its UTF-8 encoding as the object.
        byte[] bytes;
        if (!string.IsNullOrEmpty(req.Base64))
        {
            try
            {
                bytes = Convert.FromBase64String(req.Base64);
            }
            catch (FormatException)
            {
                return BadRequest(new { error = "File content is not valid base64." });
            }
        }
        else if (!string.IsNullOrEmpty(req.Text))
        {
            bytes = Encoding.UTF8.GetBytes(req.Text);
        }
        else
        {
            return BadRequest(new { error = "No file content." });
        }
        if (bytes.Length == 0) return BadRequest(new { error = "No file content." });
        if (bytes.Length > MaxBytes) return BadRequest(new { error = "File is too large." });

        var uid = Uid;
        var since = DateTimeOffset.UtcNow.AddHours(-1);
        var recent = await _db.ChatFiles.AsNoTracking()
            .CountAsync(f => f.EndUserId == uid && f.CreatedAt >= since, ct);
        if (recent >= MaxPerUserPerHour)
            return StatusCode(429, new { error = "Too many uploads. Please try again later." });

        var fileName = Clip((req.FileName ?? "").Trim(), 255);
        if (fileName.Length == 0) fileName = "file";
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

        // Dedupe: the same user re-attaching the identical bytes under the same name (very common — people
        // re-send the same photo) reuses the stored object instead of writing a second copy. Only rows that
        // actually made it to R2 count: matching a keyless row would make a file that once failed to store
        // permanently unstorable, since every retry would dedupe onto the broken row.
        var existing = await _db.ChatFiles.AsNoTracking()
            .FirstOrDefaultAsync(f => f.EndUserId == uid && f.Sha256 == sha && f.FileName == fileName
                && f.ObjectKey != "", ct);
        if (existing is not null) return Ok(new { id = existing.Id, deduped = true });

        var cfg = await _db.EmbeddingConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
        var dim = cfg?.Dimensions ?? 0;
        // Only accept the vector if its length matches the locked dimension (same vector space).
        var emb = req.Embedding is { Length: > 0 } && (dim == 0 || req.Embedding.Length == dim)
            ? req.Embedding
            : null;

        var row = new ChatFile
        {
            EndUserId = uid,
            ConversationId = Clip((req.ConversationId ?? "").Trim(), 64),
            FileName = fileName,
            Kind = kind,
            Mime = Clip(mime, 128),
            // Trust the decoded length over the client's claim — it's what we actually stored.
            SizeBytes = bytes.LongLength,
            Sha256 = sha,
            // Same 16 000-char clip as ChatMemory.Content. Beyond bounding what one row can retain, this is
            // what keeps the description under Postgres's 1 MB tsvector ceiling — the GIN expression index
            // is maintained on INSERT, so an oversized description would hard-error the write as a 500.
            Description = Clip((req.Description ?? "").Trim(), 16000),
            EmbeddingHalf = emb is null ? null : ToHalf(emb),
        };
        _db.ChatFiles.Add(row);
        await _db.SaveChangesAsync(ct);  // need the id for the object key

        var key = $"chat-files/{uid}/{row.Id}/{SanitizeName(fileName)}";
        try
        {
            using var ms = new MemoryStream(bytes);
            await _storage.PutObjectAsync(key, ms, StoredContentType(kind, mime), ct);
        }
        catch (Exception ex)
        {
            // Unlike a ChatMemory (whose text is still useful without its blob), a ChatFile row with no
            // object is a file the AI will offer and then fail to deliver. Roll it back rather than leave
            // a promise we can't keep.
            //
            // CancellationToken.None, deliberately: the commonest way to land here is the CLIENT going away
            // mid-PUT (the upload is fired detached from sendText, so closing the tab aborts it), which means
            // `ct` is already cancelled — rolling back with it would throw instantly and strand the very row
            // this block exists to remove. Its own try/catch for the same reason: a failed rollback must
            // still surface as 502, not a 500.
            try
            {
                _db.ChatFiles.Remove(row);
                await _db.SaveChangesAsync(CancellationToken.None);
            }
            catch (Exception rollbackEx)
            {
                _log.LogWarning(rollbackEx, "Failed to roll back chat file row {FileId} after a failed upload", row.Id);
            }
            _log.LogWarning(ex, "Failed to store chat file {FileId} for user {UserId}", row.Id, uid);
            return StatusCode(502, new { error = "File storage is unavailable." });
        }

        // Also non-cancellable: the bytes are already in R2, so losing this write would leave a keyless row
        // pointing at an object that exists — undeliverable, and invisible to the orphan filters below.
        row.ObjectKey = key;
        await _db.SaveChangesAsync(CancellationToken.None);
        return Ok(new { id = row.Id });
    }

    /// <summary>Find stored files. Same three-lane Reciprocal Rank Fusion as chat recall, run over the
    /// file's description:
    /// <list type="bullet">
    /// <item>vector only → pure cosine similarity;</item>
    /// <item>vector + query text → HYBRID: cosine + full-text + trigram fused by RRF;</item>
    /// <item>query text only (embeddings off/unavailable) → keyword fusion, falling back to a substring
    /// match if neither lane hits;</item>
    /// <item>neither → newest-first.</item>
    /// </list>
    /// The trigram lane also matches the FILE NAME: websearch_to_tsquery('simple', …) won't tokenize
    /// "report_q3.pdf", so asking for a file by its name would otherwise miss entirely.</summary>
    [HttpPost("search")]
    public async Task<ActionResult<IReadOnlyList<FileHit>>> Search([FromBody] FileSearchRequest req)
    {
        var uid = Uid;
        var k = Math.Clamp(req.K, 1, 50);
        // Optional date window (e.g. "the pdf I sent yesterday"): the browser supplies ISO bounds it
        // computed from the user's local date/timezone. Null bounds mean no narrowing.
        var since = req.Since;
        var until = req.Until;
        // Optional kind filter ("image" / "pdf" / "audio" / "text"); null searches everything.
        var kind = string.IsNullOrWhiteSpace(req.Kind) ? null : req.Kind!.Trim().ToLowerInvariant();
        var q = (req.Q ?? "").Trim();
        var hasVector = req.Vector is { Length: > 0 };
        var hasQuery = q.Length > 0;

        // The per-user candidate set shared by every lane (always small, since scoped to one user). Rows
        // with no ObjectKey never reached R2, so they are excluded everywhere the AI can see them: offering
        // a file we can't deliver is worse than not knowing about it.
        IQueryable<ChatFile> Scoped() => _db.ChatFiles
            .Where(f => f.EndUserId == uid
                && f.ObjectKey != ""
                && (since == null || f.CreatedAt >= since)
                && (until == null || f.CreatedAt < until)
                && (kind == null || f.Kind == kind));

        // Pure vector (no query text): straight cosine over the HNSW-indexed halfvec column.
        if (hasVector && !hasQuery)
        {
            var qv = ToHalf(req.Vector!);
            var hits = await Scoped()
                .Where(f => f.EmbeddingHalf != null)
                .OrderBy(f => f.EmbeddingHalf!.CosineDistance(qv))
                .Take(k)
                .Select(f => new FileHit(f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, f.Description, f.CreatedAt, f.EmbeddingHalf!.CosineDistance(qv)))
                .ToListAsync();
            return Ok(hits);
        }

        // Neither vector nor query: newest-first ("what did I send you recently?").
        if (!hasQuery)
        {
            var recent = await Scoped()
                .OrderByDescending(f => f.CreatedAt)
                .Take(k)
                .Select(f => new FileHit(f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, f.Description, f.CreatedAt, (double?)null))
                .ToListAsync();
            return Ok(recent);
        }

        // There is a query: fuse the applicable lanes (vector optional) with Reciprocal Rank Fusion.
        const int LaneTake = 50;      // candidates per lane before fusion
        const double RrfK = 60.0;     // standard RRF damping constant
        var fusedScore = new Dictionary<int, double>();
        var vectorDistance = new Dictionary<int, double>();

        void Accumulate(IReadOnlyList<int> ids)
        {
            for (var i = 0; i < ids.Count; i++)
                fusedScore[ids[i]] = fusedScore.GetValueOrDefault(ids[i]) + 1.0 / (RrfK + (i + 1));
        }

        // Lane 1 — vector cosine similarity (only when the browser sent an embedding).
        if (hasVector)
        {
            var qv = ToHalf(req.Vector!);
            var vec = await Scoped()
                .Where(f => f.EmbeddingHalf != null)
                .OrderBy(f => f.EmbeddingHalf!.CosineDistance(qv))
                .Take(LaneTake)
                .Select(f => new { f.Id, Dist = f.EmbeddingHalf!.CosineDistance(qv) })
                .ToListAsync();
            Accumulate(vec.Select(x => x.Id).ToList());
            foreach (var x in vec) vectorDistance[x.Id] = x.Dist;
        }

        // Lane 2 — full-text ('simple' config: tokenizes on whitespace/punctuation; ranks space-delimited
        // languages well, and is a no-op for unsegmented CJK, which lane 3 covers).
        var ftsIds = await Scoped()
            .Where(f => EF.Functions.ToTsVector("simple", f.Description).Matches(EF.Functions.WebSearchToTsQuery("simple", q)))
            .OrderByDescending(f => EF.Functions.ToTsVector("simple", f.Description).Rank(EF.Functions.WebSearchToTsQuery("simple", q)))
            .Take(LaneTake)
            .Select(f => f.Id)
            .ToListAsync();
        Accumulate(ftsIds);

        // Lane 3 — substring + trigram fuzzy match (both accelerated by the trigram GIN indexes). This is
        // the CJK lane: word_similarity is unreliable for Chinese/Japanese (incidental single-character
        // overlap dominates), so a focused CJK term is matched by ILIKE containment, while word_similarity
        // adds typo/word-order tolerance for space-delimited scripts. A full unsegmented CJK *sentence*
        // still won't keyword-match here (no segmenter) — the vector lane is the answer for that. The file
        // NAME is OR'd in on this lane only: it's the one lane that can match "report_q3.pdf" as typed.
        var trgmIds = await Scoped()
            .Where(f => EF.Functions.ILike(f.Description, $"%{q}%")
                || EF.Functions.ILike(f.FileName, $"%{q}%")
                || EF.Functions.TrigramsWordSimilarity(q, f.Description) > 0.3
                || EF.Functions.TrigramsWordSimilarity(q, f.FileName) > 0.3)
            .OrderByDescending(f => EF.Functions.TrigramsWordSimilarity(q, f.Description))
            .Take(LaneTake)
            .Select(f => f.Id)
            .ToListAsync();
        Accumulate(trgmIds);

        // Nothing matched any lane (e.g. pg_trgm unavailable and no FTS token overlap): fall back to a
        // plain substring match over description + name, newest-first.
        if (fusedScore.Count == 0)
        {
            var fallback = await Scoped()
                .Where(f => EF.Functions.ILike(f.Description, $"%{q}%") || EF.Functions.ILike(f.FileName, $"%{q}%"))
                .OrderByDescending(f => f.CreatedAt)
                .Take(k)
                .Select(f => new FileHit(f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, f.Description, f.CreatedAt, (double?)null))
                .ToListAsync();
            return Ok(fallback);
        }

        // Materialize the union of candidates, then order by fused score (newest breaks ties) and take k.
        var ids = fusedScore.Keys.ToList();
        var candidates = await Scoped()
            .Where(f => ids.Contains(f.Id))
            .Select(f => new
            {
                f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, f.Description, f.CreatedAt,
            })
            .ToListAsync();

        var fused = candidates
            .OrderByDescending(f => fusedScore[f.Id])
            .ThenByDescending(f => f.CreatedAt)
            .Take(k)
            .Select(f => new FileHit(f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, f.Description, f.CreatedAt,
                vectorDistance.TryGetValue(f.Id, out var d) ? d : (double?)null,
                fusedScore[f.Id]))
            .ToList();
        return Ok(fused);
    }

    /// <summary>Metadata for one stored file (what the send_file tool confirms against before offering it).</summary>
    [HttpGet("{id:int}")]
    public async Task<ActionResult<FileHit>> Get(int id)
    {
        var uid = Uid;
        // ObjectKey filter as in Scoped(): send_file confirms against this before offering, so a row whose
        // bytes never landed must read as "no such file" rather than become an undeliverable offer.
        var f = await _db.ChatFiles.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid && x.ObjectKey != "");
        if (f is null) return NotFound();
        return Ok(new FileHit(f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, f.Description, f.CreatedAt, null));
    }

    /// <summary>The file's bytes, inline as same-origin JSON, so the browser can rebuild the attachment
    /// exactly as if it had just been picked. Deliberately not a redirect: a cross-origin presigned
    /// redirect is awkward for fetch() and some media loaders can't follow it.</summary>
    [HttpGet("{id:int}/data")]
    public async Task<ActionResult<FileData>> Data(int id)
    {
        var uid = Uid;
        var f = await _db.ChatFiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (f is null || string.IsNullOrEmpty(f.ObjectKey)) return NotFound();
        var bytes = await _storage.GetObjectBytesAsync(f.ObjectKey, HttpContext.RequestAborted);
        if (bytes is null) return NotFound();

        // Kind "text" round-trips as text (that's what was stored); everything else as base64.
        return Ok(f.Kind == "text"
            ? new FileData(f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, null, Encoding.UTF8.GetString(bytes))
            : new FileData(f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, Convert.ToBase64String(bytes), null));
    }

    /// <summary>A short-lived presigned URL for the raw object, for direct download links. The key comes
    /// from the row, never the client, and a foreign id is 404 (not 403) so ids can't be probed.</summary>
    [HttpGet("{id:int}/content")]
    public async Task<IActionResult> Content(int id)
    {
        var uid = Uid;
        var f = await _db.ChatFiles.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (f is null || string.IsNullOrEmpty(f.ObjectKey)) return NotFound();
        var url = await _storage.GetPresignedGetUrlAsync(f.ObjectKey, TimeSpan.FromMinutes(5), HttpContext.RequestAborted);
        return url is null ? NotFound() : Redirect(url);
    }

    [HttpGet]
    public async Task<IReadOnlyList<FileHit>> List([FromQuery] int take = 50)
    {
        var uid = Uid;
        var t = Math.Clamp(take, 1, 200);
        return await _db.ChatFiles
            .Where(f => f.EndUserId == uid && f.ObjectKey != "")
            .OrderByDescending(f => f.CreatedAt)
            .Take(t)
            .Select(f => new FileHit(f.Id, f.FileName, f.Kind, f.Mime, f.SizeBytes, f.Description, f.CreatedAt, (double?)null))
            .ToListAsync();
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var uid = Uid;
        var f = await _db.ChatFiles.FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (f is null) return NotFound();

        if (!string.IsNullOrEmpty(f.ObjectKey))
        {
            try
            {
                await _storage.DeleteObjectAsync(f.ObjectKey, HttpContext.RequestAborted);
            }
            catch (Exception ex)
            {
                // Best-effort: an orphaned blob is far better than a row the user can't get rid of.
                _log.LogWarning(ex, "Failed to delete stored object {Key} for chat file {FileId}", f.ObjectKey, f.Id);
            }
        }

        _db.ChatFiles.Remove(f);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max];

    /// <summary>Make a user-supplied file name safe to use as the last segment of an object key: no path
    /// separators, no control characters, and short enough to keep the whole key well under the limit.
    /// The extension is preserved (R2/browsers key content sniffing off it) and an empty result becomes
    /// "file" — the row id already makes the key unique, so the name is only there for readability.</summary>
    private static string SanitizeName(string name)
    {
        var chars = name.Select(c => c is '/' or '\\' or ':' or '?' or '#' or '%' || char.IsControl(c) ? '_' : c).ToArray();
        var safe = new string(chars).Trim();
        if (safe.Length == 0) return "file";
        if (safe.Length <= 100) return safe;

        var ext = Path.GetExtension(safe);
        if (ext.Length is > 0 and <= 12) return string.Concat(safe.AsSpan(0, 100 - ext.Length), ext);
        return safe[..100];
    }
}
