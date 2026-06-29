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

    public AuthController(IGoogleAuthService google, AppDbContext db)
    {
        _google = google;
        _db = db;
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
