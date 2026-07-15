using Amazon.S3;
using Evervault.Api.Data;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Admin view of end-user product feedback (<see cref="Models.Suggestion"/>): a paged, searchable,
/// newest-first feed with a per-status filter, plus a presigned-redirect endpoint for viewing any
/// screenshots and a PATCH to move a suggestion through triage (new → reviewed → archived).
/// </summary>
[ApiController]
[Route("admin/suggestions")]   // behind UsePathBase("/api") → GET /api/admin/suggestions
[Authorize]                    // default scheme = AdminController.Scheme ("AdminCookie")
public class AdminSuggestionsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IStorageService _storage;

    public AdminSuggestionsController(AppDbContext db, IStorageService storage)
    {
        _db = db;
        _storage = storage;
    }

    private static readonly HashSet<string> Statuses =
        new(StringComparer.OrdinalIgnoreCase) { "new", "reviewed", "archived" };

    public record SuggestionImageDto(int Id, string Mime);
    public record SuggestionDto(int Id, int? EndUserId, string? UserEmail, string Category, string Summary,
        string Details, string Status, string? UserAgent, DateTimeOffset CreatedAt, IReadOnlyList<SuggestionImageDto> Images);
    public record SuggestionsPage(IReadOnlyList<SuggestionDto> Items, int Total, int Skip, int Take);

    /// <summary>Paged suggestions, newest first. <paramref name="q"/> matches summary, details, category,
    /// or email; <paramref name="status"/> filters to new|reviewed|archived when supplied.</summary>
    [HttpGet]
    public async Task<ActionResult<SuggestionsPage>> Get(
        [FromQuery] string? q, [FromQuery] string? status,
        [FromQuery] int skip = 0, [FromQuery] int take = 50, CancellationToken ct = default)
    {
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 200);

        var query = _db.Suggestions.AsNoTracking();

        var st = (status ?? "").Trim().ToLowerInvariant();
        if (Statuses.Contains(st)) query = query.Where(s => s.Status == st);

        var term = (q ?? "").Trim();
        if (term.Length > 0)
        {
            var pattern = $"%{term}%";
            query = query.Where(s =>
                EF.Functions.ILike(s.Summary, pattern) ||
                EF.Functions.ILike(s.Details, pattern) ||
                EF.Functions.ILike(s.Category, pattern) ||
                (s.UserEmail != null && EF.Functions.ILike(s.UserEmail, pattern)));
        }

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderByDescending(s => s.CreatedAt).ThenByDescending(s => s.Id)
            .Skip(skip).Take(take)
            .Select(s => new SuggestionDto(s.Id, s.EndUserId, s.UserEmail, s.Category, s.Summary,
                s.Details, s.Status, s.UserAgent, s.CreatedAt,
                s.Images.OrderBy(i => i.Id).Select(i => new SuggestionImageDto(i.Id, i.Mime)).ToList()))
            .ToListAsync(ct);

        return Ok(new SuggestionsPage(items, total, skip, take));
    }

    public record StatusInput(string? Status);

    /// <summary>Move a suggestion through triage. Body: { status: "new" | "reviewed" | "archived" }.</summary>
    [HttpPatch("{id:int}")]
    public async Task<IActionResult> UpdateStatus(int id, [FromBody] StatusInput req, CancellationToken ct)
    {
        var st = (req.Status ?? "").Trim().ToLowerInvariant();
        if (!Statuses.Contains(st)) return BadRequest(new { error = "Unknown status." });

        var row = await _db.Suggestions.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (row is null) return NotFound();
        row.Status = st;
        await _db.SaveChangesAsync(ct);
        return Ok(new { id, status = st });
    }

    /// <summary>302 to a short-lived presigned R2 URL for one of a suggestion's screenshots. The imageId
    /// must belong to the given suggestion. Mirrors StorageController.SampleAudio.</summary>
    [HttpGet("{id:int}/image/{imageId:int}")]
    public async Task<IActionResult> Image(int id, int imageId, CancellationToken ct)
    {
        var img = await _db.SuggestionImages.AsNoTracking()
            .FirstOrDefaultAsync(i => i.Id == imageId && i.SuggestionId == id, ct);
        if (img is null || string.IsNullOrEmpty(img.ObjectKey)) return NotFound();
        try
        {
            var url = await _storage.GetPresignedGetUrlAsync(img.ObjectKey, TimeSpan.FromMinutes(5), ct);
            return url is null ? NotFound() : Redirect(url);
        }
        catch (AmazonS3Exception ex)
        {
            return StatusCode(502, new { error = "Storage error: " + ex.Message });
        }
    }
}
