using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// The end-user's derived memory profile: durable, distilled facts the AI uses to feel like it knows
/// the user. Facts are extracted in the browser (the user's own key) and pushed here via <c>sync</c>;
/// the server only stores and serves them (it never runs AI on user content). Scoped to the signed-in
/// end-user (UserCookie). See <see cref="UserMemoryFact"/>.
/// </summary>
[ApiController]
[Route("chat/profile")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class UserProfileController : ControllerBase
{
    private readonly AppDbContext _db;

    public UserProfileController(AppDbContext db) => _db = db;

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    private const int MaxFactsPerUser = 80;

    public record FactDto(int Id, string Category, string Key, string Value, int Salience, string Source, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
    public record FactUpsert(string Category, string Key, string Value, int? Salience);
    public record FactRemove(string Category, string Key);
    public record ProfileSyncRequest(List<FactUpsert>? Upserts, List<FactRemove>? Removes);

    /// <summary>All facts for the signed-in user, most salient first.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<FactDto>> Get()
    {
        var uid = Uid;
        return await _db.UserMemoryFacts.AsNoTracking()
            .Where(f => f.EndUserId == uid)
            .OrderByDescending(f => f.Salience).ThenBy(f => f.Category).ThenBy(f => f.Key)
            .Select(f => new FactDto(f.Id, f.Category, f.Key, f.Value, f.Salience, f.Source, f.CreatedAt, f.UpdatedAt))
            .ToListAsync();
    }

    /// <summary>Apply an extraction delta: upsert by (user, category, key) and remove retracted facts.</summary>
    [HttpPost("sync")]
    public async Task<ActionResult> Sync([FromBody] ProfileSyncRequest req)
    {
        var uid = Uid;
        var now = DateTimeOffset.UtcNow;
        var existing = await _db.UserMemoryFacts.Where(f => f.EndUserId == uid).ToListAsync();
        var byIdentity = existing.ToDictionary(f => (f.Category, f.Key));

        foreach (var u in req.Upserts ?? [])
        {
            var category = (u.Category ?? "other").Trim().ToLowerInvariant();
            if (category.Length == 0) category = "other";
            if (category.Length > 32) category = category[..32];
            var key = (u.Key ?? "").Trim();
            if (key.Length == 0) continue;
            if (key.Length > 80) key = key[..80];
            var value = (u.Value ?? "").Trim();
            if (value.Length == 0) continue;
            if (value.Length > 2000) value = value[..2000];
            var salience = Math.Clamp(u.Salience ?? 3, 1, 5);

            if (byIdentity.TryGetValue((category, key), out var row))
            {
                row.Value = value;
                row.Salience = salience;
                row.UpdatedAt = now;
            }
            else
            {
                var added = new UserMemoryFact
                {
                    EndUserId = uid, Category = category, Key = key, Value = value,
                    Salience = salience, Source = "extracted", CreatedAt = now, UpdatedAt = now,
                };
                _db.UserMemoryFacts.Add(added);
                byIdentity[(category, key)] = added;
                existing.Add(added);
            }
        }

        foreach (var r in req.Removes ?? [])
        {
            var category = (r.Category ?? "").Trim().ToLowerInvariant();
            var key = (r.Key ?? "").Trim();
            // Remove() detaches a still-Added row or marks a tracked row Deleted — both correct here.
            if (byIdentity.TryGetValue((category, key), out var row))
                _db.UserMemoryFacts.Remove(row);
        }

        // Bound the token budget: keep only the most salient facts (newest breaks ties).
        var keep = existing
            .Where(f => _db.Entry(f).State != EntityState.Deleted)
            .OrderByDescending(f => f.Salience).ThenByDescending(f => f.UpdatedAt)
            .Skip(MaxFactsPerUser);
        foreach (var f in keep) _db.UserMemoryFacts.Remove(f);

        await _db.SaveChangesAsync();
        return NoContent();
    }

    /// <summary>User removes one fact from their profile (the "About you" panel).</summary>
    [HttpDelete("facts/{id:int}")]
    public async Task<IActionResult> DeleteFact(int id)
    {
        var uid = Uid;
        var f = await _db.UserMemoryFacts.FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (f is null) return NotFound();
        _db.UserMemoryFacts.Remove(f);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    /// <summary>Clear the whole profile.</summary>
    [HttpDelete]
    public async Task<IActionResult> Clear([FromQuery] bool all)
    {
        if (!all) return BadRequest(new { error = "Pass ?all=true to clear your whole profile." });
        var uid = Uid;
        await _db.UserMemoryFacts.Where(f => f.EndUserId == uid).ExecuteDeleteAsync();
        return NoContent();
    }
}
