using System.Globalization;
using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// The end-user's structured task list — concrete to-dos with an explicit due date, so "what do I need
/// to do today?" is a deterministic agenda query instead of a semantic guess over past chat. Tasks are
/// extracted in the browser (the user's own key) and pushed here via <c>sync</c>, or created/updated by
/// the in-chat task tools; the server only stores and serves them (it never runs AI on user content).
/// Scoped to the signed-in end-user (UserCookie). See <see cref="UserTask"/>.
/// </summary>
[ApiController]
[Route("chat/tasks")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class UserTasksController : ControllerBase
{
    private readonly AppDbContext _db;

    public UserTasksController(AppDbContext db) => _db = db;

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    // Bound the token budget of the injected agenda + the per-user row count.
    private const int MaxOpenTasksPerUser = 100;

    // Recurrence + LastCompletedAt are appended LAST and are optional on the way in: a previously
    // shipped client deserializes the extra JSON properties harmlessly and never sends them.
    public record TaskDto(int Id, string Title, string? Details, string? DueDate, string? DueTime,
        string Status, string Source, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? CompletedAt,
        string? Recurrence = null, DateTimeOffset? LastCompletedAt = null);
    public record TaskCreate(string Title, string? Details, string? DueDate, string? DueTime, string? Source, string? ConversationId,
        string? Recurrence = null);
    public record TaskPatch(string? Title, string? Details, string? DueDate, string? DueTime, string? Status,
        string? Recurrence = null);
    public record TaskAdd(string Title, string? Details, string? DueDate, string? DueTime);
    public record TasksSyncRequest(List<TaskAdd>? Adds, List<int>? Completes, List<int>? Dismisses, string? ConversationId);

    private static TaskDto ToDto(UserTask t) => new(
        t.Id, t.Title, t.Details,
        t.DueDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), t.DueTime,
        t.Status, t.Source, t.CreatedAt, t.UpdatedAt, t.CompletedAt,
        t.Recurrence, t.LastCompletedAt);

    // Parse a client-supplied "yyyy-MM-dd" into a DateOnly, or null if absent/malformed. Extraction
    // output is model-generated, so we drop bad values rather than 400 the whole batch.
    private static DateOnly? ParseDate(string? s) =>
        DateOnly.TryParseExact((s ?? "").Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
            ? d : null;

    private static string? ParseTime(string? s)
    {
        s = (s ?? "").Trim();
        return System.Text.RegularExpressions.Regex.IsMatch(s, @"^\d{2}:\d{2}$") ? s : null;
    }

    // The repeat-rule grammar (see UserTask.Recurrence). The server only validates the shape and
    // stores it — the browser is what interprets it, because it is the only side that reliably knows
    // the user's wall calendar. Like ParseDate/ParseTime, an unrecognised value is dropped rather than
    // 400-ing, since the input is model-generated: a bad rule degrades to a plain one-off task.
    private static readonly System.Text.RegularExpressions.Regex RecurrenceRe = new(
        @"^(daily|weekdays|weekends|weekly:(mon|tue|wed|thu|fri|sat|sun)(,(mon|tue|wed|thu|fri|sat|sun))*|monthly:([1-9]|[12][0-9]|3[01]))$",
        System.Text.RegularExpressions.RegexOptions.Compiled);

    private static string? ParseRecurrence(string? s)
    {
        s = (s ?? "").Trim().ToLowerInvariant();
        return RecurrenceRe.IsMatch(s) ? s : null;
    }

    /// <summary>
    /// Record one occurrence of a repeating task as done WITHOUT closing the series. A recurring task
    /// is a single row that stays "open" while its due date rolls forward, so completing it must never
    /// set Status/CompletedAt — those mean "finished for good", and a previously-shipped client reads
    /// them that way. This is also the safety net for a stale browser tab: its complete_task sends
    /// status:"done" with no idea the task repeats, and without this the user's recurring reminder
    /// would be silently killed the first time they ticked it off from an un-refreshed page.
    /// </summary>
    private static void TickOccurrence(UserTask t, DateTimeOffset now)
    {
        t.LastCompletedAt = now;
        t.UpdatedAt = now;
    }

    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;

    /// <summary>Tasks for the signed-in user. Default open only; due date ascending (undated last).</summary>
    [HttpGet]
    public async Task<IReadOnlyList<TaskDto>> Get([FromQuery] string status = "open", [FromQuery] int take = 100)
    {
        var uid = Uid;
        var t = Math.Clamp(take, 1, 200);
        var q = _db.UserTasks.AsNoTracking().Where(x => x.EndUserId == uid);
        var s = (status ?? "open").Trim().ToLowerInvariant();
        if (s != "all") q = q.Where(x => x.Status == s);
        return await q
            .OrderBy(x => x.DueDate == null).ThenBy(x => x.DueDate).ThenByDescending(x => x.CreatedAt)
            .Take(t)
            .Select(x => ToDto(x))
            .ToListAsync();
    }

    /// <summary>User or the in-chat AI creates one task.</summary>
    [HttpPost]
    public async Task<ActionResult<TaskDto>> Create([FromBody] TaskCreate req)
    {
        var uid = Uid;
        var title = (req.Title ?? "").Trim();
        if (title.Length == 0) return BadRequest(new { error = "Title is required." });
        var now = DateTimeOffset.UtcNow;
        var source = (req.Source ?? "user").Trim().ToLowerInvariant();
        if (source is not ("user" or "ai" or "extracted")) source = "user";

        var task = new UserTask
        {
            EndUserId = uid,
            Title = Clip(title, 200),
            Details = string.IsNullOrWhiteSpace(req.Details) ? null : Clip(req.Details.Trim(), 2000),
            DueDate = ParseDate(req.DueDate),
            DueTime = ParseTime(req.DueTime),
            Recurrence = ParseRecurrence(req.Recurrence),
            Status = "open",
            Source = source,
            SourceConversationId = string.IsNullOrWhiteSpace(req.ConversationId) ? null : Clip(req.ConversationId.Trim(), 64),
            CreatedAt = now,
            UpdatedAt = now,
        };
        _db.UserTasks.Add(task);
        await _db.SaveChangesAsync();
        return Ok(ToDto(task));
    }

    /// <summary>Apply an extraction delta: complete/dismiss existing tasks, then add new ones
    /// (skipping duplicates of an open task with the same title + due date).</summary>
    [HttpPost("sync")]
    public async Task<ActionResult> Sync([FromBody] TasksSyncRequest req)
    {
        var uid = Uid;
        var now = DateTimeOffset.UtcNow;
        var mine = await _db.UserTasks.Where(t => t.EndUserId == uid).ToListAsync();
        var byId = mine.ToDictionary(t => t.Id);

        foreach (var id in req.Completes ?? [])
            if (byId.TryGetValue(id, out var t) && t.Status == "open")
            {
                // A repeating task is never "done" — tick the occurrence and leave the series running.
                if (t.Recurrence is not null)
                {
                    TickOccurrence(t, now);
                    continue;
                }
                t.Status = "done";
                t.CompletedAt = now;
                t.UpdatedAt = now;
            }

        foreach (var id in req.Dismisses ?? [])
            if (byId.TryGetValue(id, out var t) && t.Status == "open")
            {
                t.Status = "dismissed";
                t.UpdatedAt = now;
            }

        // Duplicate guard: an *open* task with the same normalized title and same due date already exists.
        var openKeys = mine
            .Where(t => t.Status == "open")
            .Select(t => (t.Title.Trim().ToLowerInvariant(), t.DueDate))
            .ToHashSet();
        var openCount = mine.Count(t => t.Status == "open");

        foreach (var a in req.Adds ?? [])
        {
            if (openCount >= MaxOpenTasksPerUser) break;
            var title = (a.Title ?? "").Trim();
            if (title.Length == 0) continue;
            var due = ParseDate(a.DueDate);
            var key = (title.ToLowerInvariant(), due);
            if (!openKeys.Add(key)) continue; // already tracked (Add returns false if present)

            _db.UserTasks.Add(new UserTask
            {
                EndUserId = uid,
                Title = Clip(title, 200),
                Details = string.IsNullOrWhiteSpace(a.Details) ? null : Clip(a.Details.Trim(), 2000),
                DueDate = due,
                DueTime = ParseTime(a.DueTime),
                Status = "open",
                Source = "extracted",
                SourceConversationId = string.IsNullOrWhiteSpace(req.ConversationId) ? null : Clip(req.ConversationId.Trim(), 64),
                CreatedAt = now,
                UpdatedAt = now,
            });
            openCount++;
        }

        await _db.SaveChangesAsync();
        return NoContent();
    }

    /// <summary>Partial update: title/details/dueDate/dueTime/status. Empty-string dueDate/dueTime clears it.</summary>
    [HttpPatch("{id:int}")]
    public async Task<ActionResult<TaskDto>> Patch(int id, [FromBody] TaskPatch req)
    {
        var uid = Uid;
        var t = await _db.UserTasks.FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (t is null) return NotFound();
        var now = DateTimeOffset.UtcNow;

        if (req.Title is not null)
        {
            var title = req.Title.Trim();
            if (title.Length > 0) t.Title = Clip(title, 200);
        }
        if (req.Details is not null)
            t.Details = req.Details.Trim().Length == 0 ? null : Clip(req.Details.Trim(), 2000);
        if (req.DueDate is not null)
            t.DueDate = req.DueDate.Trim().Length == 0 ? null : ParseDate(req.DueDate) ?? t.DueDate;
        if (req.DueTime is not null)
            t.DueTime = req.DueTime.Trim().Length == 0 ? null : ParseTime(req.DueTime) ?? t.DueTime;
        // Empty string turns a repeating task back into a one-off; an unparseable rule leaves it alone.
        if (req.Recurrence is not null)
            t.Recurrence = req.Recurrence.Trim().Length == 0 ? null : ParseRecurrence(req.Recurrence) ?? t.Recurrence;
        if (req.Status is not null)
        {
            var s = req.Status.Trim().ToLowerInvariant();
            if (s is "open" or "done" or "dismissed")
            {
                // "done" on a repeating task ticks the occurrence instead of ending the series. Note
                // this reads t.Recurrence AFTER the patch above, so clearing the rule and completing
                // in one request does finish the task — which is what that combination should mean.
                // "dismissed" is deliberately NOT intercepted: it is how the user stops a repeat for
                // good, and so is DELETE.
                if (s == "done" && t.Recurrence is not null)
                {
                    TickOccurrence(t, now);
                }
                else
                {
                    t.Status = s;
                    t.CompletedAt = s == "done" ? now : null;
                }
            }
        }
        t.UpdatedAt = now;
        await _db.SaveChangesAsync();
        return Ok(ToDto(t));
    }

    /// <summary>Delete one task.</summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var uid = Uid;
        var t = await _db.UserTasks.FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (t is null) return NotFound();
        _db.UserTasks.Remove(t);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    /// <summary>Clear the whole task list.</summary>
    [HttpDelete]
    public async Task<IActionResult> Clear([FromQuery] bool all)
    {
        if (!all) return BadRequest(new { error = "Pass ?all=true to clear all your tasks." });
        var uid = Uid;
        await _db.UserTasks.Where(t => t.EndUserId == uid).ExecuteDeleteAsync();
        return NoContent();
    }
}
