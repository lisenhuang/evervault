using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Public end-user authentication for the /webapp chat, via "Sign in with Google". The web client uses
/// its own cookie (ev_user) after a Google Identity Services ID token; the native app uses the
/// backend-driven OAuth code flow (start/callback) + a bearer session token — see
/// <see cref="UserTokenService"/>. Kept separate from the admin session.
/// </summary>
[ApiController]
[Route("auth")]
public class AuthController : ControllerBase
{
    public const string Scheme = "UserCookie";
    public const string BearerScheme = "UserBearer";
    /// <summary>Accept EITHER the web cookie or the app bearer token on end-user endpoints.</summary>
    public const string UserAuth = Scheme + "," + BearerScheme;

    // App redirect (deep link) schemes we'll hand a session token to. Custom app schemes + Expo dev.
    private static readonly HashSet<string> AllowedRedirectSchemes =
        new(StringComparer.OrdinalIgnoreCase) { "evervault", "exp", "exps" };

    private readonly IGoogleAuthService _google;
    private readonly AppDbContext _db;
    private readonly IStorageService _storage;
    private readonly UserTokenService _tokens;
    private readonly ITimeLimitedDataProtector _stateProtector;
    private readonly ILogger<AuthController> _log;

    public AuthController(IGoogleAuthService google, AppDbContext db, IStorageService storage,
        UserTokenService tokens, IDataProtectionProvider dp, ILogger<AuthController> log)
    {
        _google = google;
        _db = db;
        _storage = storage;
        _tokens = tokens;
        _stateProtector = dp.CreateProtector("Evervault.OAuthState").ToTimeLimitedDataProtector();
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

        var user = await UpsertUserAsync(payload);
        await SignInAsync(user);
        return Ok(new { email = user.Email, name = user.Name, picture = user.Picture });
    }

    /// <summary>Begin the native app's Google login inside an in-app browser (Custom Tab / SFSafariVC).
    /// Redirects to Google's consent screen. <c>redirect_uri</c> is the app's deep link (e.g.
    /// <c>evervault://auth</c>) we hand the session token back to; it is signed into <c>state</c> so the
    /// callback can trust it. The app never needs a Google client id or native Google config.</summary>
    [HttpGet("google/start")]
    [AllowAnonymous]
    public async Task<IActionResult> GoogleStart([FromQuery(Name = "redirect_uri")] string? redirectUri)
    {
        var clientId = await _google.GetClientIdIfEnabledAsync();
        if (clientId is null) return Problem("Google login is not enabled.", statusCode: 400);
        if (!IsAllowedAppRedirect(redirectUri)) return Problem("Invalid or missing redirect_uri.", statusCode: 400);

        var state = _stateProtector.Protect(redirectUri!, TimeSpan.FromMinutes(10));
        var url = "https://accounts.google.com/o/oauth2/v2/auth"
            + "?client_id=" + Uri.EscapeDataString(clientId)
            + "&redirect_uri=" + Uri.EscapeDataString(CallbackUrl())
            + "&response_type=code"
            + "&scope=" + Uri.EscapeDataString("openid email profile")
            + "&include_granted_scopes=true"
            + "&prompt=select_account"
            + "&state=" + Uri.EscapeDataString(state);
        return Redirect(url);
    }

    /// <summary>Google redirects here with an authorization code. We exchange it server-side (with the
    /// stored, encrypted client secret), verify the id_token, upsert the end-user, mint a bearer session
    /// token, and redirect back to the app's deep link with <c>?token=…</c> (or <c>?error=…</c>).</summary>
    [HttpGet("google/callback")]
    [AllowAnonymous]
    public async Task<IActionResult> GoogleCallback([FromQuery] string? code, [FromQuery] string? state, [FromQuery] string? error)
    {
        string appRedirect;
        try { appRedirect = _stateProtector.Unprotect(state ?? ""); }
        catch { return Problem("The login session expired or was invalid. Please try again.", statusCode: 400); }

        if (!string.IsNullOrEmpty(error) || string.IsNullOrEmpty(code))
            return Redirect(AppendQuery(appRedirect, "error", error ?? "no_code"));

        var payload = await _google.ExchangeCodeAsync(code, CallbackUrl(), HttpContext.RequestAborted);
        if (payload is null) return Redirect(AppendQuery(appRedirect, "error", "auth_failed"));
        if (!payload.EmailVerified) return Redirect(AppendQuery(appRedirect, "error", "email_unverified"));

        var user = await UpsertUserAsync(payload);
        var token = _tokens.Issue(user);
        return Redirect(AppendQuery(appRedirect, "token", token));
    }

    [HttpGet("me")]
    [Authorize(AuthenticationSchemes = UserAuth)]
    public IActionResult Me() => Ok(new
    {
        email = User.FindFirst(ClaimTypes.Email)?.Value,
        name = User.FindFirst(ClaimTypes.Name)?.Value,
        picture = User.FindFirst("picture")?.Value,
    });

    [HttpPost("logout")]
    [Authorize(AuthenticationSchemes = UserAuth)]
    public async Task<IActionResult> Logout()
    {
        // Cookie clients are signed out here; bearer (app) tokens are stateless — the app just discards
        // its stored token. SignOut on the cookie scheme is a no-op for a bearer-authenticated request.
        await HttpContext.SignOutAsync(Scheme);
        return Ok();
    }

    /// <summary>Permanently delete the signed-in user's account and ALL data derived from it:
    /// chat memories, the memory profile, stored audio blobs, and the account row itself. The
    /// session cookie is cleared so the browser is signed out. Irreversible.</summary>
    [HttpDelete("account")]
    [Authorize(AuthenticationSchemes = UserAuth)]
    public async Task<IActionResult> DeleteAccount()
    {
        var uid = int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

        // Best-effort blob purge first: audio lives under chat-audio/{uid}/. If storage is
        // unconfigured or errors, still delete the DB rows so the account is truly gone.
        try
        {
            await _storage.DeleteByPrefixAsync($"chat-audio/{uid}/", HttpContext.RequestAborted);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to purge stored audio for deleted user {UserId}", uid);
        }

        await _db.ChatMemories.Where(m => m.EndUserId == uid).ExecuteDeleteAsync();
        await _db.UserMemoryFacts.Where(f => f.EndUserId == uid).ExecuteDeleteAsync();
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

    /// <summary>Create-or-update the end-user row from a verified Google payload (shared by the web
    /// ID-token path and the app OAuth-code path).</summary>
    private async Task<EndUser> UpsertUserAsync(Google.Apis.Auth.GoogleJsonWebSignature.Payload payload)
    {
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
        return user;
    }

    /// <summary>Absolute URL of our OAuth callback, honoring the nginx/Cloudflare forwarded scheme+host
    /// and the "/api" path base — must exactly match the redirect_uri registered in the Google console.</summary>
    private string CallbackUrl() => $"{Request.Scheme}://{Request.Host}{Request.PathBase}/auth/google/callback";

    private static bool IsAllowedAppRedirect(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri) || !Uri.TryCreate(uri, UriKind.Absolute, out var u)) return false;
        if (AllowedRedirectSchemes.Contains(u.Scheme)) return true;
        // Expo web / localhost during development.
        return (u.Scheme is "http" or "https") && u.Host is "localhost" or "127.0.0.1";
    }

    private static string AppendQuery(string uri, string key, string value)
    {
        var sep = uri.Contains('?') ? '&' : '?';
        return $"{uri}{sep}{key}={Uri.EscapeDataString(value)}";
    }
}
