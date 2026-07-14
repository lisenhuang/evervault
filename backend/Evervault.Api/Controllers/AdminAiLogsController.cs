using Evervault.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Admin read-only feed for <see cref="Models.AiCallLog"/> rows: every AI provider API call, recorded at
/// the failover choke point (which pooled key handled it, model, tokens, outcome). A newest-first table for
/// spotting quota/auth bursts, plus a rollup for the header tiles. Rows are swept after 30 days.
/// </summary>
[ApiController]
[Route("admin/ai-logs")]   // behind UsePathBase("/api") → GET /api/admin/ai-logs
[Authorize]                // default scheme = AdminController.Scheme ("AdminCookie")
public class AdminAiLogsController : ControllerBase
{
    private readonly AppDbContext _db;

    public AdminAiLogsController(AppDbContext db) => _db = db;

    public record AiCallLogDto(int Id, DateTimeOffset CreatedAt, string Provider, string Area, string? Model,
        string? KeyHint, int Attempts, string Outcome, string? ErrorKind, string? ErrorMessage, int? HttpStatus,
        int? PromptTokens, int? CompletionTokens, int? TotalTokens, int? DurationMs, int? EndUserId, string? Detail);
    public record AiCallLogsPage(IReadOnlyList<AiCallLogDto> Items, int Total, int Skip, int Take);

    public record StatBucket(string Key, int Calls, long Tokens);
    public record AiCallLogStats(int Hours, int TotalCalls, int FailedCalls, long TotalTokens,
        IReadOnlyList<StatBucket> ByProvider, IReadOnlyList<StatBucket> ByArea, IReadOnlyList<StatBucket> ByModel);

    /// <summary>Paged calls, newest first. <paramref name="q"/> matches model, key hint, or error message;
    /// <paramref name="provider"/>/<paramref name="area"/>/<paramref name="outcome"/> are exact filters.</summary>
    [HttpGet]
    public async Task<ActionResult<AiCallLogsPage>> Get(
        [FromQuery] string? q, [FromQuery] string? provider, [FromQuery] string? area, [FromQuery] string? outcome,
        [FromQuery] int skip = 0, [FromQuery] int take = 50, CancellationToken ct = default)
    {
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 200);

        var query = _db.AiCallLogs.AsNoTracking();

        var term = (q ?? "").Trim();
        if (term.Length > 0)
        {
            var pattern = $"%{term}%";
            query = query.Where(r =>
                EF.Functions.ILike(r.Model!, pattern) ||       // nullable columns: ILike on NULL is false in
                EF.Functions.ILike(r.KeyHint!, pattern) ||     // Postgres, which is the behaviour we want
                EF.Functions.ILike(r.ErrorMessage!, pattern));
        }

        var providerFilter = (provider ?? "").Trim();
        if (providerFilter.Length > 0)
            query = query.Where(r => r.Provider == providerFilter);

        var areaFilter = (area ?? "").Trim();
        if (areaFilter.Length > 0)
            query = query.Where(r => r.Area == areaFilter);

        var outcomeFilter = (outcome ?? "").Trim();
        if (outcomeFilter.Length > 0)
            query = query.Where(r => r.Outcome == outcomeFilter);

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Id)
            .Skip(skip).Take(take)
            .Select(r => new AiCallLogDto(r.Id, r.CreatedAt, r.Provider, r.Area, r.Model, r.KeyHint, r.Attempts,
                r.Outcome, r.ErrorKind, r.ErrorMessage, r.HttpStatus, r.PromptTokens, r.CompletionTokens,
                r.TotalTokens, r.DurationMs, r.EndUserId, r.Detail))
            .ToListAsync(ct);

        return Ok(new AiCallLogsPage(items, total, skip, take));
    }

    /// <summary>Rollup over the last <paramref name="hours"/> (clamped 1–720) for the header tiles.</summary>
    [HttpGet("stats")]
    public async Task<ActionResult<AiCallLogStats>> Stats([FromQuery] int hours = 24, CancellationToken ct = default)
    {
        hours = Math.Clamp(hours, 1, 720);
        var since = DateTimeOffset.UtcNow.AddHours(-hours);

        var query = _db.AiCallLogs.AsNoTracking().Where(r => r.CreatedAt >= since);

        var totalCalls = await query.CountAsync(ct);
        var failedCalls = await query.CountAsync(r => r.Outcome == "failed", ct);
        var totalTokens = await query.SumAsync(r => (long?)r.TotalTokens, ct) ?? 0L;

        // Grouped server-side into anonymous rows, then mapped to the DTO in memory (keeps the EF projection
        // to shapes it translates cleanly). Buckets are ordered by call count, descending.
        var byProvider = (await query
                .GroupBy(r => r.Provider)
                .Select(g => new { g.Key, Calls = g.Count(), Tokens = g.Sum(r => (long?)r.TotalTokens) })
                .ToListAsync(ct))
            .OrderByDescending(g => g.Calls)
            .Select(g => new StatBucket(g.Key, g.Calls, g.Tokens ?? 0L))
            .ToList();

        var byArea = (await query
                .GroupBy(r => r.Area)
                .Select(g => new { g.Key, Calls = g.Count(), Tokens = g.Sum(r => (long?)r.TotalTokens) })
                .ToListAsync(ct))
            .OrderByDescending(g => g.Calls)
            .Select(g => new StatBucket(g.Key, g.Calls, g.Tokens ?? 0L))
            .ToList();

        var byModel = (await query
                .GroupBy(r => r.Model ?? "—")
                .Select(g => new { g.Key, Calls = g.Count(), Tokens = g.Sum(r => (long?)r.TotalTokens) })
                .OrderByDescending(g => g.Calls)
                .Take(8)
                .ToListAsync(ct))
            .Select(g => new StatBucket(g.Key, g.Calls, g.Tokens ?? 0L))
            .ToList();

        return Ok(new AiCallLogStats(hours, totalCalls, failedCalls, totalTokens, byProvider, byArea, byModel));
    }
}
