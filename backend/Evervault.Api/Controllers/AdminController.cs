using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

[ApiController]
[Route("admin")]
public class AdminController : ControllerBase
{
    public const string Scheme = "AdminCookie";

    private readonly AppDbContext _db;
    public AdminController(AppDbContext db) => _db = db;

    public record SetupRequest(string Email, string Password);
    public record LoginRequest(string Email, string Password);

    /// <summary>Whether an admin account already exists (drives setup-vs-login in the UI).</summary>
    [HttpGet("status")]
    [AllowAnonymous]
    public async Task<object> Status() => new { initialized = await _db.Admins.AnyAsync() };

    /// <summary>First-run account creation. Hard-rejects once any admin exists (one-time only).</summary>
    [HttpPost("setup")]
    [AllowAnonymous]
    public async Task<IActionResult> Setup(SetupRequest req)
    {
        if (await _db.Admins.AnyAsync())
            return Conflict(new { error = "An admin account already exists." });

        var email = (req.Email ?? "").Trim().ToLowerInvariant();
        if (email.Length == 0 || !email.Contains('@') || string.IsNullOrWhiteSpace(req.Password) || req.Password.Length < 8)
            return BadRequest(new { error = "A valid email and a password of at least 8 characters are required." });

        var admin = new AdminUser { Email = email, PasswordHash = PasswordHashing.Hash(req.Password) };
        _db.Admins.Add(admin);
        try
        {
            await _db.SaveChangesAsync();
        }
        catch (DbUpdateException) // unique-email race backstop
        {
            return Conflict(new { error = "An admin account already exists." });
        }

        await SignInAsync(admin);
        return Ok(new { email = admin.Email });
    }

    [HttpPost("login")]
    [AllowAnonymous]
    public async Task<IActionResult> Login(LoginRequest req)
    {
        var email = (req.Email ?? "").Trim().ToLowerInvariant();
        var admin = await _db.Admins.FirstOrDefaultAsync(a => a.Email == email);
        if (admin is null || !PasswordHashing.Verify(req.Password ?? "", admin.PasswordHash))
            return Unauthorized(new { error = "Invalid email or password." });

        await SignInAsync(admin);
        return Ok(new { email = admin.Email });
    }

    [HttpGet("me")]
    [Authorize]
    public IActionResult Me() => Ok(new { email = User.FindFirst(ClaimTypes.Email)?.Value });

    [HttpPost("logout")]
    [Authorize]
    public async Task<IActionResult> Logout()
    {
        await HttpContext.SignOutAsync(Scheme);
        return Ok();
    }

    private Task SignInAsync(AdminUser admin)
    {
        var identity = new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, admin.Id.ToString()),
                new Claim(ClaimTypes.Email, admin.Email),
            ],
            Scheme);
        return HttpContext.SignInAsync(Scheme, new ClaimsPrincipal(identity));
    }
}
