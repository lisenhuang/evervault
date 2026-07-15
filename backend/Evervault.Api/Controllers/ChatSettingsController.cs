using System.Security.Claims;
using Evervault.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// The signed-in end-user's /webapp preferences, stored server-side so they follow the account across
/// devices/browsers instead of living only in one browser's localStorage. Today this is just the
/// per-surface response style (text replies / spoken voice replies / live calls). Future scalar prefs
/// (voice, memory toggle) should be added as more nullable columns on <see cref="Models.EndUser"/> under
/// this same endpoint, not a new table, until prefs genuinely balloon. Scoped to the signed-in end-user
/// (UserCookie). On the wire "default" is the zero-config baseline; it maps to a null column, so null is
/// the single source of "use the built-in tone".
/// </summary>
[ApiController]
[Route("chat/settings")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatSettingsController : ControllerBase
{
    private readonly AppDbContext _db;

    public ChatSettingsController(AppDbContext db) => _db = db;

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    // The non-default response-style presets the client offers. Anything else — including the literal
    // "default" and any stale/unknown value — is stored as null, keeping null the only "built-in tone".
    private static readonly HashSet<string> KnownStyles =
        new(StringComparer.OrdinalIgnoreCase) { "concise", "friendly", "detailed", "professional", "playful" };

    private static string Out(string? s) => s ?? "default";                 // null column -> "default" on the wire
    private static string? Normalize(string? s) =>                          // wire value -> column (unknown/"default" -> null)
        s is not null && KnownStyles.Contains(s.Trim()) ? s.Trim().ToLowerInvariant() : null;

    public record SettingsDto(string TextStyle, string VoiceStyle, string LiveStyle);

    // Partial update: a field that is null/omitted leaves that surface unchanged; send the literal
    // "default" (or any unknown value) to reset a surface. An omitted field and an explicit JSON null are
    // indistinguishable here (both deserialize to null), so the client resets by sending "default", never
    // by omitting or sending null.
    public record SettingsUpdate(string? TextStyle, string? VoiceStyle, string? LiveStyle);

    /// <summary>The signed-in user's response-style prefs (each "default" when unset).</summary>
    [HttpGet]
    public async Task<SettingsDto> Get()
    {
        var uid = Uid;
        var u = await _db.EndUsers.AsNoTracking()
            .Where(x => x.Id == uid)
            .Select(x => new { x.TextStyle, x.VoiceStyle, x.LiveStyle })
            .FirstOrDefaultAsync();
        // A still-valid cookie after account deletion (or any missing row) reads as all-default.
        return new SettingsDto(Out(u?.TextStyle), Out(u?.VoiceStyle), Out(u?.LiveStyle));
    }

    /// <summary>Update the prefs. Only non-null fields are applied; "default"/unknown clears to null.</summary>
    [HttpPut]
    public async Task<IActionResult> Put([FromBody] SettingsUpdate req)
    {
        var uid = Uid;
        var u = await _db.EndUsers.FirstOrDefaultAsync(x => x.Id == uid);
        if (u is null) return NotFound(); // deleted account with a live cookie — don't recreate the row
        if (req.TextStyle is not null) u.TextStyle = Normalize(req.TextStyle);
        if (req.VoiceStyle is not null) u.VoiceStyle = Normalize(req.VoiceStyle);
        if (req.LiveStyle is not null) u.LiveStyle = Normalize(req.LiveStyle);
        await _db.SaveChangesAsync();
        return NoContent();
    }
}
