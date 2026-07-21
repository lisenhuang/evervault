using System.Globalization;
using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Dated things happening in the user's life, so the assistant can ask how the interview went. Extracted
/// in the browser (the user's own key) and pushed here via <c>sync</c>; the server only stores and
/// serves. Scoped to the signed-in end-user (UserCookie). See <see cref="UserLifeEvent"/>.
/// </summary>
[ApiController]
[Route("chat/events")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class UserLifeEventsController : ControllerBase
{
    private readonly AppDbContext _db;

    public UserLifeEventsController(AppDbContext db) => _db = db;

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    private const int MaxOpenEventsPerUser = 60;
    // Long-tail retention: an event a year old is history, not something to bring up.
    private const int RetentionDays = 400;

    public record EventDto(int Id, string Title, string? Details, string? EventDate, string Status,
        DateTimeOffset? FollowedUpAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
    public record EventAdd(string Title, string? Details, string? EventDate);
    public record EventsSyncRequest(List<EventAdd>? Adds, List<int>? FollowedUp, List<int>? Closes, string? ConversationId);

    private static EventDto ToDto(UserLifeEvent e) => new(
        e.Id, e.Title, e.Details,
        e.EventDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        e.Status, e.FollowedUpAt, e.CreatedAt, e.UpdatedAt);

    private static DateOnly? ParseDate(string? s) =>
        DateOnly.TryParseExact((s ?? "").Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
            ? d : null;

    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;

    /// <summary>Events for the signed-in user. Default open only, soonest first.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<EventDto>> Get([FromQuery] string status = "open", [FromQuery] int take = 60)
    {
        var uid = Uid;
        // Amortised sweep on the read path — the house idiom, since there is no scheduler. Bounded to
        // this user's rows so it uses the (EndUserId, EventDate) index rather than scanning the table.
        var cutoff = DateTimeOffset.UtcNow.AddDays(-RetentionDays);
        await _db.UserLifeEvents.Where(e => e.EndUserId == uid && e.UpdatedAt < cutoff).ExecuteDeleteAsync();

        var t = Math.Clamp(take, 1, 200);
        var q = _db.UserLifeEvents.AsNoTracking().Where(e => e.EndUserId == uid);
        var s = (status ?? "open").Trim().ToLowerInvariant();
        if (s != "all") q = q.Where(e => e.Status == s);
        return await q
            .OrderBy(e => e.EventDate == null).ThenBy(e => e.EventDate)
            .Take(t)
            .Select(e => ToDto(e))
            .ToListAsync();
    }

    /// <summary>Apply an extraction delta: add newly-mentioned events, mark ones we've asked about, close finished ones.</summary>
    [HttpPost("sync")]
    public async Task<ActionResult> Sync([FromBody] EventsSyncRequest req)
    {
        var uid = Uid;
        var now = DateTimeOffset.UtcNow;
        var mine = await _db.UserLifeEvents.Where(e => e.EndUserId == uid).ToListAsync();
        var byId = mine.ToDictionary(e => e.Id);

        foreach (var id in req.FollowedUp ?? [])
            if (byId.TryGetValue(id, out var e) && e.FollowedUpAt is null)
            {
                e.FollowedUpAt = now;
                e.UpdatedAt = now;
            }

        foreach (var id in req.Closes ?? [])
            if (byId.TryGetValue(id, out var e) && e.Status == "open")
            {
                e.Status = "closed";
                e.UpdatedAt = now;
            }

        // Duplicate guard, mirroring /chat/tasks/sync: the same event mentioned across several
        // conversations must not accumulate a row each time.
        var openKeys = mine
            .Where(e => e.Status == "open")
            .Select(e => (e.Title.Trim().ToLowerInvariant(), e.EventDate))
            .ToHashSet();
        var openCount = mine.Count(e => e.Status == "open");

        foreach (var a in req.Adds ?? [])
        {
            if (openCount >= MaxOpenEventsPerUser) break;
            var title = (a.Title ?? "").Trim();
            if (title.Length == 0) continue;
            var when = ParseDate(a.EventDate);
            if (!openKeys.Add((title.ToLowerInvariant(), when))) continue;

            _db.UserLifeEvents.Add(new UserLifeEvent
            {
                EndUserId = uid,
                Title = Clip(title, 200),
                Details = string.IsNullOrWhiteSpace(a.Details) ? null : Clip(a.Details.Trim(), 1000),
                EventDate = when,
                Status = "open",
                SourceConversationId = string.IsNullOrWhiteSpace(req.ConversationId) ? null : Clip(req.ConversationId.Trim(), 64),
                CreatedAt = now,
                UpdatedAt = now,
            });
            openCount++;
        }

        await _db.SaveChangesAsync();
        return NoContent();
    }

    /// <summary>Remove one event — the delete path behind the forget tool's `event` scope.</summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var uid = Uid;
        var e = await _db.UserLifeEvents.FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (e is null) return NotFound();
        _db.UserLifeEvents.Remove(e);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    /// <summary>Clear them all.</summary>
    [HttpDelete]
    public async Task<IActionResult> Clear([FromQuery] bool all)
    {
        if (!all) return BadRequest(new { error = "Pass ?all=true to clear all your events." });
        var uid = Uid;
        await _db.UserLifeEvents.Where(e => e.EndUserId == uid).ExecuteDeleteAsync();
        return NoContent();
    }
}
