using System.Security.Claims;
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
/// End-user conversation memory: record each turn (text + optional push-to-talk audio + a client-computed
/// embedding) and recall it by vector search. The server NEVER embeds — the browser embeds with the user's
/// own Gemini key using the admin's chosen model+dimension and sends the vector here. Scoped to the
/// signed-in end-user (UserCookie).
/// </summary>
[ApiController]
[Route("chat/memories")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatMemoriesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IStorageService _storage;

    public ChatMemoriesController(AppDbContext db, IStorageService storage)
    {
        _db = db;
        _storage = storage;
    }

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    public record EmbeddingPolicy(bool Enabled, string? Model, int Dimensions);
    public record TurnItem(string Role, string Modality, string? Text, string? AudioBase64, string? AudioMime, float[]? Embedding, string? ImageBase64 = null, string? ImageMime = null);
    public record RecordTurnRequest(string? ConversationId, List<TurnItem> Turns);
    public record SearchRequest(float[]? Vector, string? Q, int K = 8, DateTimeOffset? Since = null, DateTimeOffset? Until = null, string? Kind = null);
    public record MemoryHit(int Id, string Role, string Modality, string Kind, string Content, bool HasAudio, bool HasImage, DateTimeOffset CreatedAt, double? Distance);
    public record SummaryRequest(string ConversationId, string Text, float[]? Embedding);

    /// <summary>The embedding policy the browser must embed with (its own key). enabled = locked + model set.</summary>
    [HttpGet("config")]
    public async Task<ActionResult<EmbeddingPolicy>> Config()
    {
        var c = await _db.EmbeddingConfigs.AsNoTracking().FirstOrDefaultAsync();
        var enabled = c is { LockedAt: not null } && !string.IsNullOrWhiteSpace(c.Model);
        return Ok(new EmbeddingPolicy(enabled, enabled ? c!.Model : null, c?.Dimensions ?? 1536));
    }

    /// <summary>Record one finished turn (one or more messages). Raw content is always stored; the vector
    /// and audio are best-effort.</summary>
    [HttpPost]
    public async Task<ActionResult> Record([FromBody] RecordTurnRequest req)
    {
        if (req.Turns is null || req.Turns.Count == 0) return BadRequest(new { error = "No turns to record." });
        var convId = string.IsNullOrWhiteSpace(req.ConversationId) ? Guid.NewGuid().ToString("N") : req.ConversationId!.Trim();
        var cfg = await _db.EmbeddingConfigs.AsNoTracking().FirstOrDefaultAsync();
        var dim = cfg?.Dimensions ?? 0;
        var uid = Uid;

        var ids = new List<int>();
        foreach (var t in req.Turns)
        {
            var content = (t.Text ?? "").Trim();
            if (content.Length == 0 && string.IsNullOrEmpty(t.AudioBase64) && string.IsNullOrEmpty(t.ImageBase64)) continue;

            // Only accept the vector if its length matches the locked dimension (same vector space).
            var vector = t.Embedding is { Length: > 0 } && (dim == 0 || t.Embedding.Length == dim)
                ? new Vector(t.Embedding)
                : null;

            var row = new ChatMemory
            {
                EndUserId = uid,
                ConversationId = convId,
                Role = t.Role == "assistant" ? "assistant" : "user",
                Modality = t.Modality is "voice" or "live" or "image" ? t.Modality : "text",
                Content = content.Length > 16000 ? content[..16000] : content,
                Embedding = vector,
            };
            _db.ChatMemories.Add(row);
            await _db.SaveChangesAsync(); // need the id for the audio object key
            ids.Add(row.Id);

            if (!string.IsNullOrEmpty(t.AudioBase64))
            {
                try
                {
                    var bytes = Convert.FromBase64String(t.AudioBase64);
                    var key = $"chat-audio/{uid}/{convId}/{row.Id}.wav";
                    using var ms = new MemoryStream(bytes);
                    await _storage.PutObjectAsync(key, ms, string.IsNullOrWhiteSpace(t.AudioMime) ? "audio/wav" : t.AudioMime!, HttpContext.RequestAborted);
                    row.AudioObjectKey = key;
                    await _db.SaveChangesAsync();
                }
                catch
                {
                    // Best-effort: keep the text row even if the audio upload fails (e.g. storage not set up).
                }
            }

            if (!string.IsNullOrEmpty(t.ImageBase64))
            {
                try
                {
                    var bytes = Convert.FromBase64String(t.ImageBase64);
                    var mime = string.IsNullOrWhiteSpace(t.ImageMime) ? "image/jpeg" : t.ImageMime!;
                    var key = $"chat-images/{uid}/{convId}/{row.Id}{ImageExt(mime)}";
                    using var ms = new MemoryStream(bytes);
                    await _storage.PutObjectAsync(key, ms, mime, HttpContext.RequestAborted);
                    row.ImageObjectKey = key;
                    await _db.SaveChangesAsync();
                }
                catch
                {
                    // Best-effort: keep the text row even if the image upload fails (e.g. storage not set up).
                }
            }
        }
        return Ok(new { ids });
    }

    /// <summary>Recall by vector (preferred) or text fallback. The browser supplies the query vector
    /// (embedded with its own key + the locked model/dimension).</summary>
    [HttpPost("search")]
    public async Task<ActionResult<IReadOnlyList<MemoryHit>>> Search([FromBody] SearchRequest req)
    {
        var uid = Uid;
        var k = Math.Clamp(req.K, 1, 50);
        // Optional date window (e.g. "yesterday"): the browser supplies ISO bounds it computed from the
        // user's local date/timezone. Null bounds mean no narrowing, so existing callers are unaffected.
        var since = req.Since;
        var until = req.Until;
        // Optional kind filter ("summary" / "turn"); null searches everything (unchanged behavior).
        var kind = string.IsNullOrWhiteSpace(req.Kind) ? null : req.Kind;

        if (req.Vector is { Length: > 0 })
        {
            var qv = new Vector(req.Vector);
            var hits = await _db.ChatMemories
                .Where(m => m.EndUserId == uid && m.Embedding != null
                    && (since == null || m.CreatedAt >= since)
                    && (until == null || m.CreatedAt < until)
                    && (kind == null || m.Kind == kind))
                .OrderBy(m => m.Embedding!.CosineDistance(qv))
                .Take(k)
                .Select(m => new MemoryHit(m.Id, m.Role, m.Modality, m.Kind, m.Content, m.AudioObjectKey != null, m.ImageObjectKey != null, m.CreatedAt, m.Embedding!.CosineDistance(qv)))
                .ToListAsync();
            return Ok(hits);
        }

        var q = (req.Q ?? "").Trim();
        var rows = await _db.ChatMemories
            .Where(m => m.EndUserId == uid && (q == "" || EF.Functions.ILike(m.Content, $"%{q}%"))
                && (since == null || m.CreatedAt >= since)
                && (until == null || m.CreatedAt < until)
                && (kind == null || m.Kind == kind))
            .OrderByDescending(m => m.CreatedAt)
            .Take(k)
            .Select(m => new MemoryHit(m.Id, m.Role, m.Modality, m.Kind, m.Content, m.AudioObjectKey != null, m.ImageObjectKey != null, m.CreatedAt, (double?)null))
            .ToListAsync();
        return Ok(rows);
    }

    [HttpGet]
    public async Task<IReadOnlyList<MemoryHit>> List([FromQuery] string? conversationId, [FromQuery] int take = 50)
    {
        var uid = Uid;
        var t = Math.Clamp(take, 1, 200);
        var query = _db.ChatMemories.Where(m => m.EndUserId == uid);
        if (!string.IsNullOrWhiteSpace(conversationId)) query = query.Where(m => m.ConversationId == conversationId);
        return await query
            .OrderByDescending(m => m.CreatedAt)
            .Take(t)
            .Select(m => new MemoryHit(m.Id, m.Role, m.Modality, m.Kind, m.Content, m.AudioObjectKey != null, m.ImageObjectKey != null, m.CreatedAt, (double?)null))
            .ToListAsync();
    }

    /// <summary>Upsert the single episodic summary for a conversation (replaces any prior one), so recall
    /// can retrieve one coherent summary per conversation instead of many raw turns.</summary>
    [HttpPost("summary")]
    public async Task<ActionResult> Summary([FromBody] SummaryRequest req)
    {
        var content = (req.Text ?? "").Trim();
        var convId = (req.ConversationId ?? "").Trim();
        if (content.Length == 0 || convId.Length == 0) return BadRequest(new { error = "conversationId and text are required." });
        var uid = Uid;

        await _db.ChatMemories
            .Where(m => m.EndUserId == uid && m.ConversationId == convId && m.Kind == "summary")
            .ExecuteDeleteAsync();

        var cfg = await _db.EmbeddingConfigs.AsNoTracking().FirstOrDefaultAsync();
        var dim = cfg?.Dimensions ?? 0;
        var vector = req.Embedding is { Length: > 0 } && (dim == 0 || req.Embedding.Length == dim)
            ? new Vector(req.Embedding)
            : null;

        _db.ChatMemories.Add(new ChatMemory
        {
            EndUserId = uid,
            ConversationId = convId,
            Role = "assistant",
            Modality = "text",
            Kind = "summary",
            Content = content.Length > 16000 ? content[..16000] : content,
            Embedding = vector,
        });
        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpGet("{id:int}/audio")]
    public async Task<IActionResult> Audio(int id)
    {
        var uid = Uid;
        var m = await _db.ChatMemories.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (m is null || string.IsNullOrEmpty(m.AudioObjectKey)) return NotFound();
        var url = await _storage.GetPresignedGetUrlAsync(m.AudioObjectKey, TimeSpan.FromMinutes(5), HttpContext.RequestAborted);
        return url is null ? NotFound() : Redirect(url);
    }

    [HttpGet("{id:int}/image")]
    public async Task<IActionResult> Image(int id)
    {
        var uid = Uid;
        var m = await _db.ChatMemories.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (m is null || string.IsNullOrEmpty(m.ImageObjectKey)) return NotFound();
        var url = await _storage.GetPresignedGetUrlAsync(m.ImageObjectKey, TimeSpan.FromMinutes(5), HttpContext.RequestAborted);
        return url is null ? NotFound() : Redirect(url);
    }

    /// <summary>File extension (with dot) for the stored image's MIME type; unknown types keep ".jpg".</summary>
    private static string ImageExt(string mime) => mime.ToLowerInvariant() switch
    {
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/heic" => ".heic",
        "image/heif" => ".heif",
        _ => ".jpg",
    };

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var uid = Uid;
        var m = await _db.ChatMemories.FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (m is null) return NotFound();
        _db.ChatMemories.Remove(m);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpDelete]
    public async Task<IActionResult> Clear([FromQuery] bool all)
    {
        if (!all) return BadRequest(new { error = "Pass ?all=true to clear all your memories." });
        var uid = Uid;
        await _db.ChatMemories.Where(m => m.EndUserId == uid).ExecuteDeleteAsync();
        return NoContent();
    }
}
