using System.Security.Claims;
using System.Text.Json;
using Evervault.Api.Controllers;
using Evervault.Api.Models;
using Microsoft.AspNetCore.DataProtection;

namespace Evervault.Api.Services;

/// <summary>
/// Issues and validates stateless end-user session tokens for the native app (which can't use the
/// browser <c>ev_user</c> cookie). A token is just the user's identity, encrypted + signed with Data
/// Protection and given a 30-day lifetime — no JWT secret to manage and no server-side session table,
/// matching the project's zero-config rule. The web keeps using the cookie; this is purely additive.
/// </summary>
public class UserTokenService
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(30);

    private readonly ITimeLimitedDataProtector _protector;

    public UserTokenService(IDataProtectionProvider dp)
        => _protector = dp.CreateProtector("Evervault.UserToken").ToTimeLimitedDataProtector();

    private record Payload(int Id, string Email, string Name, string? Picture);

    /// <summary>Mint an opaque bearer token for the given end-user (valid for <see cref="Lifetime"/>).</summary>
    public string Issue(EndUser user)
    {
        var json = JsonSerializer.Serialize(new Payload(user.Id, user.Email, user.Name, user.Picture));
        return _protector.Protect(json, Lifetime);
    }

    /// <summary>Validate a bearer token and rebuild the claims principal, or null if invalid/expired.</summary>
    public ClaimsPrincipal? Validate(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        try
        {
            var payload = JsonSerializer.Deserialize<Payload>(_protector.Unprotect(token));
            if (payload is null) return null;

            var claims = new List<Claim>
            {
                new(ClaimTypes.NameIdentifier, payload.Id.ToString()),
                new(ClaimTypes.Email, payload.Email),
                new(ClaimTypes.Name, payload.Name),
            };
            if (!string.IsNullOrEmpty(payload.Picture)) claims.Add(new Claim("picture", payload.Picture));

            var identity = new ClaimsIdentity(claims, AuthController.BearerScheme);
            return new ClaimsPrincipal(identity);
        }
        catch
        {
            return null; // tampered, malformed, or expired
        }
    }
}
