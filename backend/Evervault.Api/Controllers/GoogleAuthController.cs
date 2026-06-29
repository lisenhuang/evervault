using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Admin-only configuration of "Sign in with Google" (client id/secret, encrypted), plus binding the
/// current admin account to a Google identity so they can later sign in with Google. Uses the default
/// (AdminCookie) scheme.
/// </summary>
[ApiController]
[Route("admin/auth/google")]
[Authorize]
public class GoogleAuthController : ControllerBase
{
    private readonly IGoogleAuthService _google;
    private readonly AppDbContext _db;

    public GoogleAuthController(IGoogleAuthService google, AppDbContext db)
    {
        _google = google;
        _db = db;
    }

    public record IdTokenRequest(string IdToken);

    /// <summary>Current Google OAuth config (client secret masked as a boolean).</summary>
    [HttpGet]
    public async Task<ActionResult<GoogleAuthConfigDto>> Get()
    {
        var dto = await _google.GetAsync();
        return dto is null ? NoContent() : Ok(dto);
    }

    /// <summary>Save the Google OAuth config (client secret encrypted before storage).</summary>
    [HttpPut]
    public async Task<ActionResult<GoogleAuthConfigDto>> Save(GoogleAuthConfigInput input)
    {
        await _google.SaveAsync(input);
        return Ok(await _google.GetAsync());
    }

    /// <summary>Link the signed-in admin to a Google account (verifies a "Sign in with Google" token).</summary>
    [HttpPost("bind")]
    public async Task<IActionResult> Bind(IdTokenRequest req)
    {
        var payload = await _google.VerifyIdTokenAsync(req.IdToken ?? "");
        if (payload is null)
            return BadRequest(new { error = "Save and enable Google login first, then connect your account." });

        var adminId = int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

        var clash = await _db.Admins.FirstOrDefaultAsync(a => a.GoogleSub == payload.Subject && a.Id != adminId);
        if (clash is not null)
            return Conflict(new { error = "That Google account is already linked to another admin." });

        var admin = await _db.Admins.FirstAsync(a => a.Id == adminId);
        admin.GoogleSub = payload.Subject;
        admin.GoogleEmail = payload.Email;
        await _db.SaveChangesAsync();
        return Ok(new { googleEmail = admin.GoogleEmail });
    }

    /// <summary>Unlink the signed-in admin's Google account. Password login is unaffected.</summary>
    [HttpDelete("bind")]
    public async Task<IActionResult> Unbind()
    {
        var adminId = int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);
        var admin = await _db.Admins.FirstAsync(a => a.Id == adminId);
        admin.GoogleSub = null;
        admin.GoogleEmail = null;
        await _db.SaveChangesAsync();
        return Ok();
    }
}
