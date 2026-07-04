using System.Text.Encodings.Web;
using Evervault.Api.Controllers;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Evervault.Api.Services;

/// <summary>
/// Authenticates the native app's end-user session from an <c>Authorization: Bearer &lt;token&gt;</c> header
/// (or an <c>?access_token=</c> query param, which the app uses for the Live WebSocket, since RN sockets
/// can't set request headers). The token is a Data-Protection session token minted by
/// <see cref="UserTokenService"/>. Registered as an additional scheme alongside the <c>UserCookie</c>
/// scheme, so end-user endpoints accept either the browser cookie or the app's bearer token.
/// </summary>
public class UserBearerAuthenticationHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    private readonly UserTokenService _tokens;

    public UserBearerAuthenticationHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        UserTokenService tokens)
        : base(options, logger, encoder)
        => _tokens = tokens;

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        string? token = null;

        var header = Request.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            token = header["Bearer ".Length..].Trim();
        else if (Request.Query.TryGetValue("access_token", out var q))
            token = q.ToString();

        // No credential → NoResult (not a failure), so a combined "UserCookie,UserBearer" policy can
        // still fall back to the cookie handler.
        if (string.IsNullOrEmpty(token)) return Task.FromResult(AuthenticateResult.NoResult());

        var principal = _tokens.Validate(token);
        if (principal is null) return Task.FromResult(AuthenticateResult.Fail("Invalid or expired session token."));

        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name)));
    }
}
