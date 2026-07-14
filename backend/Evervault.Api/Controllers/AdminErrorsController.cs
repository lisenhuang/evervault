using Evervault.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Admin lookup for <see cref="Models.ErrorReport"/> rows: a user quotes the reference code from their
/// error bubble ("EV-…"), the admin searches it here and sees the full detail that was never shown to
/// the user. Also a plain newest-first feed for spotting failure bursts.
/// </summary>
[ApiController]
[Route("admin/errors")]   // behind UsePathBase("/api") → GET /api/admin/errors
[Authorize]               // default scheme = AdminController.Scheme ("AdminCookie")
public class AdminErrorsController : ControllerBase
{
    private readonly AppDbContext _db;

    public AdminErrorsController(AppDbContext db) => _db = db;

    public record ErrorReportDto(int Id, string Code, string Source, string Area, int? EndUserId,
        int? HttpStatus, string Message, string? Detail, string? UserAgent, DateTimeOffset CreatedAt);
    public record ErrorReportsPage(IReadOnlyList<ErrorReportDto> Items, int Total, int Skip, int Take);

    /// <summary>Paged reports, newest first. <paramref name="q"/> matches code, area, or message.</summary>
    [HttpGet]
    public async Task<ActionResult<ErrorReportsPage>> Get(
        [FromQuery] string? q, [FromQuery] int skip = 0, [FromQuery] int take = 50, CancellationToken ct = default)
    {
        skip = Math.Max(0, skip);
        take = Math.Clamp(take, 1, 200);

        var query = _db.ErrorReports.AsNoTracking();
        var term = (q ?? "").Trim();
        if (term.Length > 0)
        {
            var pattern = $"%{term}%";
            query = query.Where(r =>
                EF.Functions.ILike(r.Code, pattern) ||
                EF.Functions.ILike(r.Area, pattern) ||
                EF.Functions.ILike(r.Message, pattern));
        }

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Id)
            .Skip(skip).Take(take)
            .Select(r => new ErrorReportDto(r.Id, r.Code, r.Source, r.Area, r.EndUserId,
                r.HttpStatus, r.Message, r.Detail, r.UserAgent, r.CreatedAt))
            .ToListAsync(ct);

        return Ok(new ErrorReportsPage(items, total, skip, take));
    }
}
