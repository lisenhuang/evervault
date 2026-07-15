using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// End-user product feedback from the /webapp chat. The AI records a row here ONLY after the user agrees
/// to pass their idea to the developers (see the client-side record_suggestion tool). Any screenshots the
/// user shared with the suggestion are uploaded to R2 and linked as <see cref="SuggestionImage"/> rows.
/// Read back by admins in /admin/suggestions. Gated to signed-in webapp users (the ev_user cookie).
/// </summary>
[ApiController]
[Route("chat/suggestions")]   // behind UsePathBase("/api") → POST /api/chat/suggestions
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class SuggestionsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IStorageService _storage;

    public SuggestionsController(AppDbContext db, IStorageService storage)
    {
        _db = db;
        _storage = storage;
    }

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);
    private string? Email => User.FindFirst(ClaimTypes.Email)?.Value;

    // A user can only send a handful of suggestions in a normal session; cap the rest so a runaway
    // tool loop (or abuse) can't flood the table.
    private const int MaxPerUserPerHour = 20;
    // At most this many screenshots ride along with one suggestion (the composer caps attachments too).
    private const int MaxImages = 6;

    private static readonly HashSet<string> Categories =
        new(StringComparer.OrdinalIgnoreCase) { "feature", "bug", "praise", "complaint", "other" };

    public record SuggestionImageInput(string? Base64, string? Mime);
    public record SuggestionInput(string? Summary, string? Details, string? Category, List<SuggestionImageInput>? Images);

    /// <summary>Store one user suggestion plus any attached screenshots. Returns the new id.</summary>
    [HttpPost]
    [RequestSizeLimit(20_000_000)]   // ~6 downscaled screenshots as base64, well under the client's inline budget
    public async Task<IActionResult> Create([FromBody] SuggestionInput req, CancellationToken ct)
    {
        var details = (req.Details ?? "").Trim();
        var summary = (req.Summary ?? "").Trim();
        // A suggestion needs *something* to read; the summary alone is enough if that's all the model sent.
        if (details.Length == 0 && summary.Length == 0)
            return BadRequest(new { error = "A suggestion needs some text." });
        if (summary.Length == 0) summary = details;

        var uid = Uid;
        var since = DateTimeOffset.UtcNow.AddHours(-1);
        var recent = await _db.Suggestions.AsNoTracking()
            .CountAsync(s => s.EndUserId == uid && s.CreatedAt >= since, ct);
        if (recent >= MaxPerUserPerHour)
            return StatusCode(429, new { error = "Too many suggestions. Please try again later." });

        var category = (req.Category ?? "").Trim().ToLowerInvariant();
        if (!Categories.Contains(category)) category = "other";

        var row = new Suggestion
        {
            EndUserId = uid,
            UserEmail = Clip(Email, 320),
            Category = category,
            Summary = Clip(summary, 300)!,
            Details = Clip(details.Length == 0 ? summary : details, 8000)!,
            Status = "new",
            UserAgent = Clip(Request.Headers.UserAgent.ToString(), 400),
        };
        _db.Suggestions.Add(row);
        await _db.SaveChangesAsync(ct); // need the id for the image object keys

        // Upload each screenshot best-effort, collecting the rows for the ones that land. We insert them
        // all at the end in one SaveChanges rather than per-image, so a failed save can't leave a
        // half-tracked entity in the context that a later save would retry.
        var images = req.Images ?? new List<SuggestionImageInput>();
        var uploaded = new List<SuggestionImage>();
        var n = 0;
        foreach (var img in images.Take(MaxImages))
        {
            if (string.IsNullOrWhiteSpace(img.Base64)) continue;
            try
            {
                var bytes = Convert.FromBase64String(img.Base64);
                var mime = string.IsNullOrWhiteSpace(img.Mime) ? "image/jpeg" : img.Mime!.Trim();
                var key = $"suggestion-images/{uid}/{row.Id}/{n}{ImageExt(mime)}";
                using var ms = new MemoryStream(bytes);
                await _storage.PutObjectAsync(key, ms, mime, ct);
                uploaded.Add(new SuggestionImage { SuggestionId = row.Id, ObjectKey = key, Mime = Clip(mime, 64)! });
                n++;
            }
            catch
            {
                // Best-effort per image: keep the suggestion even if a screenshot fails to decode or
                // storage isn't configured. The text is the part that matters.
            }
        }
        if (uploaded.Count > 0)
        {
            try
            {
                _db.SuggestionImages.AddRange(uploaded);
                await _db.SaveChangesAsync(ct);
            }
            catch
            {
                // Best-effort: the suggestion text is already saved; the screenshots just couldn't be linked.
            }
        }

        return Ok(new { ok = true, id = row.Id });
    }

    private static string? Clip(string? s, int max) =>
        string.IsNullOrEmpty(s) ? s : (s.Length <= max ? s : s[..max]);

    /// <summary>File extension (with dot) for a stored image's MIME type; unknown types keep ".jpg".</summary>
    private static string ImageExt(string mime) => mime.ToLowerInvariant() switch
    {
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/heic" => ".heic",
        "image/heif" => ".heif",
        _ => ".jpg",
    };
}
