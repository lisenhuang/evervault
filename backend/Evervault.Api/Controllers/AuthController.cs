using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Public end-user authentication for the /webapp chat, via "Sign in with Google". Uses its own
/// cookie (ev_user) and scheme, kept separate from the admin session.
/// </summary>
[ApiController]
[Route("auth")]
public class AuthController : ControllerBase
{
    public const string Scheme = "UserCookie";

    private readonly IGoogleAuthService _google;
    private readonly AppDbContext _db;
    private readonly IStorageService _storage;
    private readonly ILogger<AuthController> _log;

    public AuthController(IGoogleAuthService google, AppDbContext db, IStorageService storage, ILogger<AuthController> log)
    {
        _google = google;
        _db = db;
        _storage = storage;
        _log = log;
    }

    public record IdTokenRequest(string IdToken);

    /// <summary>Whether Google sign-in is enabled, plus the public client id to init Google Identity Services.</summary>
    [HttpGet("config")]
    [AllowAnonymous]
    public async Task<object> Config()
    {
        var clientId = await _google.GetClientIdIfEnabledAsync();
        return new { enabled = clientId is not null, clientId };
    }

    /// <summary>Verify a Google ID token, upsert the end-user, and start a session.</summary>
    [HttpPost("google")]
    [AllowAnonymous]
    public async Task<IActionResult> Google(IdTokenRequest req)
    {
        var payload = await _google.VerifyIdTokenAsync(req.IdToken ?? "");
        if (payload is null)
            return Unauthorized(new { error = "Google login is not enabled, or the token is invalid." });
        if (!payload.EmailVerified)
            return Unauthorized(new { error = "Your Google email address is not verified." });

        var user = await _db.EndUsers.FirstOrDefaultAsync(u => u.GoogleSub == payload.Subject);
        if (user is null)
        {
            user = new EndUser { GoogleSub = payload.Subject };
            _db.EndUsers.Add(user);
        }
        user.Email = payload.Email ?? "";
        user.Name = string.IsNullOrWhiteSpace(payload.Name) ? (payload.Email ?? "") : payload.Name;
        user.Picture = payload.Picture;
        user.LastLoginAt = DateTimeOffset.UtcNow;

        // Record the visitor's IP + geo from Cloudflare edge headers (best-effort; nulls when absent).
        var geo = CloudflareGeo.From(Request);
        user.LastIp = geo.Ip;
        user.LastCountry = geo.Country;
        user.LastCity = geo.City;
        user.LastRegion = geo.Region;
        user.LastContinent = geo.Continent;
        user.LastLatitude = geo.Latitude;
        user.LastLongitude = geo.Longitude;
        user.LastPostalCode = geo.PostalCode;
        user.LastTimezone = geo.Timezone;

        await _db.SaveChangesAsync();

        await SignInAsync(user);
        return Ok(new { email = user.Email, name = user.Name, picture = user.Picture });
    }

    [HttpGet("me")]
    [Authorize(AuthenticationSchemes = Scheme)]
    public IActionResult Me() => Ok(new
    {
        email = User.FindFirst(ClaimTypes.Email)?.Value,
        name = User.FindFirst(ClaimTypes.Name)?.Value,
        picture = User.FindFirst("picture")?.Value,
    });

    [HttpPost("logout")]
    [Authorize(AuthenticationSchemes = Scheme)]
    public async Task<IActionResult> Logout()
    {
        await HttpContext.SignOutAsync(Scheme);
        return Ok();
    }

    /// <summary>Permanently delete the signed-in user's account and ALL data derived from it:
    /// chat memories, the verbatim conversation record and what the user pinned in it, the memory profile,
    /// tasks, the durable chat files (rows + blobs), every stored audio/image blob, and the account row itself. Chat files and the
    /// conversation record are retained forever otherwise, so this is the only path that removes them.
    /// The session cookie is cleared so the browser is signed out. Irreversible.</summary>
    [HttpDelete("account")]
    [Authorize(AuthenticationSchemes = Scheme)]
    public async Task<IActionResult> DeleteAccount()
    {
        var uid = int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

        // Best-effort blob purge first: push-to-talk audio under chat-audio/{uid}/, turn images under
        // chat-images/{uid}/, and the durable attachments under chat-files/{uid}/. If storage is
        // unconfigured or errors, still delete the DB rows so the account is truly gone.
        try
        {
            await _storage.DeleteByPrefixAsync($"chat-audio/{uid}/", HttpContext.RequestAborted);
            await _storage.DeleteByPrefixAsync($"chat-images/{uid}/", HttpContext.RequestAborted);
            await _storage.DeleteByPrefixAsync($"chat-files/{uid}/", HttpContext.RequestAborted);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to purge stored blobs for deleted user {UserId}", uid);
        }

        await _db.ChatMemories.Where(m => m.EndUserId == uid).ExecuteDeleteAsync();
        // The verbatim conversation record. Nothing else ever removes a row from it — it is deliberately
        // append-only, and the forget flow only takes things out of ChatMemories — so this is the single
        // path that erases it, and the reason the assistant answers "delete everything" with account
        // deletion rather than by forgetting things one at a time.
        await _db.ChatTranscripts.Where(t => t.EndUserId == uid).ExecuteDeleteAsync();
        await _db.ChatFiles.Where(f => f.EndUserId == uid).ExecuteDeleteAsync();
        await _db.UserMemoryFacts.Where(f => f.EndUserId == uid).ExecuteDeleteAsync();
        await _db.UserTasks.Where(t => t.EndUserId == uid).ExecuteDeleteAsync();
        // EndUserId is a plain int with no foreign key, so nothing cascades — every per-user table has
        // to be listed here by hand. Miss one and it survives account deletion as an intact orphan,
        // which would also make the promise we tell users ("everything is erased") untrue.
        await _db.UserStates.Where(s => s.EndUserId == uid).ExecuteDeleteAsync();
        await _db.UserLifeEvents.Where(e => e.EndUserId == uid).ExecuteDeleteAsync();
        await _db.ChatConversations.Where(c => c.EndUserId == uid).ExecuteDeleteAsync();
        await _db.EndUsers.Where(u => u.Id == uid).ExecuteDeleteAsync();

        await HttpContext.SignOutAsync(Scheme);
        return Ok();
    }

    private Task SignInAsync(EndUser user)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(ClaimTypes.Email, user.Email),
            new(ClaimTypes.Name, user.Name),
        };
        if (!string.IsNullOrEmpty(user.Picture))
            claims.Add(new Claim("picture", user.Picture));

        var identity = new ClaimsIdentity(claims, Scheme);
        // Persist the cookie across browser restarts so the session lasts its full lifetime
        // (ev_user: 30 days, sliding) instead of dying as a session cookie on browser close.
        var props = new AuthenticationProperties { IsPersistent = true };
        return HttpContext.SignInAsync(Scheme, new ClaimsPrincipal(identity), props);
    }
}
