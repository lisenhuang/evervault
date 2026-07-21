using System.Globalization;
using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// How the user has recently been doing — the "you said you'd had a rough week, how's it going?" layer.
/// Extracted in the browser (the user's own key) and pushed here via <c>sync</c>; the server only stores
/// and serves them, and never runs AI on user content. Scoped to the signed-in end-user (UserCookie).
/// See <see cref="UserState"/>.
/// </summary>
[ApiController]
[Route("chat/states")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class UserStatesController : ControllerBase
{
    private readonly AppDbContext _db;

    public UserStatesController(AppDbContext db) => _db = db;

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    // A handful of themes is the whole point — this is "how are they lately", not a mood log.
    private const int MaxStatesPerUser = 12;
    // Hard retention. The client stops INJECTING a state well before this (a fortnight-old bad week is
    // not current), but nothing should keep sitting in the database long after it stopped being true.
    private const int RetentionDays = 60;

    public record StateDto(int Id, string Key, string Value, string? NotedOn, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
    public record StateUpsert(string Key, string Value, string? NotedOn);
    public record StatesSyncRequest(List<StateUpsert>? Upserts, List<string>? Removes);

    private static StateDto ToDto(UserState s) => new(
        s.Id, s.Key, s.Value,
        s.NotedOn?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        s.CreatedAt, s.UpdatedAt);

    private static DateOnly? ParseDate(string? s) =>
        DateOnly.TryParseExact((s ?? "").Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
            ? d : null;

    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;

    /// <summary>Current states for the signed-in user, most recently updated first.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<StateDto>> Get()
    {
        var uid = Uid;
        // Amortised sweep on the read path — the house idiom here, since there is no scheduler. Cheap:
        // it is bounded by the unique (EndUserId, Key) index and only ever touches this user's rows.
        var cutoff = DateTimeOffset.UtcNow.AddDays(-RetentionDays);
        await _db.UserStates.Where(s => s.EndUserId == uid && s.UpdatedAt < cutoff).ExecuteDeleteAsync();

        return await _db.UserStates.AsNoTracking()
            .Where(s => s.EndUserId == uid)
            .OrderByDescending(s => s.UpdatedAt)
            .Select(s => ToDto(s))
            .ToListAsync();
    }

    /// <summary>Apply an extraction delta: upsert by (user, key), and drop anything explicitly retracted.</summary>
    [HttpPost("sync")]
    public async Task<ActionResult> Sync([FromBody] StatesSyncRequest req)
    {
        var uid = Uid;
        var now = DateTimeOffset.UtcNow;
        var existing = await _db.UserStates.Where(s => s.EndUserId == uid).ToListAsync();
        var byKey = existing.ToDictionary(s => s.Key);

        foreach (var u in req.Upserts ?? [])
        {
            var key = (u.Key ?? "").Trim().ToLowerInvariant();
            if (key.Length == 0) continue;
            key = Clip(key, 40);
            var value = (u.Value ?? "").Trim();
            if (value.Length == 0) continue;
            value = Clip(value, 500);

            if (byKey.TryGetValue(key, out var row))
            {
                row.Value = value;
                row.NotedOn = ParseDate(u.NotedOn) ?? row.NotedOn;
                row.UpdatedAt = now;
            }
            else
            {
                var added = new UserState
                {
                    EndUserId = uid, Key = key, Value = value,
                    NotedOn = ParseDate(u.NotedOn), CreatedAt = now, UpdatedAt = now,
                };
                _db.UserStates.Add(added);
                byKey[key] = added;
                existing.Add(added);
            }
        }

        foreach (var r in req.Removes ?? [])
        {
            var key = (r ?? "").Trim().ToLowerInvariant();
            if (byKey.TryGetValue(key, out var row)) _db.UserStates.Remove(row);
        }

        // Keep only the freshest few; a state that hasn't been mentioned in a while is not current.
        var stale = existing
            .Where(s => _db.Entry(s).State != EntityState.Deleted)
            .OrderByDescending(s => s.UpdatedAt)
            .Skip(MaxStatesPerUser);
        foreach (var s in stale) _db.UserStates.Remove(s);

        await _db.SaveChangesAsync();
        return NoContent();
    }

    /// <summary>User drops one thing the AI had noted about how they've been.</summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var uid = Uid;
        var s = await _db.UserStates.FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (s is null) return NotFound();
        _db.UserStates.Remove(s);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    /// <summary>Clear all of them.</summary>
    [HttpDelete]
    public async Task<IActionResult> Clear([FromQuery] bool all)
    {
        if (!all) return BadRequest(new { error = "Pass ?all=true to clear all of these." });
        var uid = Uid;
        await _db.UserStates.Where(s => s.EndUserId == uid).ExecuteDeleteAsync();
        return NoContent();
    }
}
