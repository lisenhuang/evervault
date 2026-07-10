using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

/// <summary>
/// Admin-only "Sign in with ChatGPT" (Codex OAuth) connection for the chat's third provider. OpenAI
/// locks the OAuth redirect to <c>http://localhost:1455</c>, so login is: <c>connect/start</c> returns
/// the authorize URL to open in a new tab, the admin signs in, and pastes the (dead) redirected URL back
/// into <c>connect/complete</c> — we exchange the code server-side. Tokens are stored encrypted and never
/// returned. Uses the default (AdminCookie) scheme.
/// </summary>
[ApiController]
[Route("admin/ai/openai")]
[Authorize]
public class OpenAiAuthController : ControllerBase
{
    private readonly IOpenAiOAuthService _openai;
    public OpenAiAuthController(IOpenAiOAuthService openai) => _openai = openai;

    public record CompleteInput(string? RedirectUrl);

    /// <summary>Current connection status (connected email + token expiry; never any secret).</summary>
    [HttpGet]
    public async Task<ActionResult<OpenAiOAuthStatusDto>> Get()
        => Ok(await _openai.GetStatusAsync(HttpContext.RequestAborted));

    /// <summary>Begin a login: returns the authorize URL to open in a new browser tab.</summary>
    [HttpPost("connect/start")]
    public async Task<IActionResult> Start()
    {
        var url = await _openai.BuildAuthorizeUrlAsync(HttpContext.RequestAborted);
        return Ok(new { authorizeUrl = url });
    }

    /// <summary>Finish a login from the pasted redirect URL (contains the code + state).</summary>
    [HttpPost("connect/complete")]
    public async Task<ActionResult<OpenAiOAuthStatusDto>> Complete([FromBody] CompleteInput input)
    {
        try
        {
            return Ok(await _openai.CompleteAsync(input.RedirectUrl ?? "", HttpContext.RequestAborted));
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    /// <summary>Disconnect the ChatGPT account (clears the stored tokens).</summary>
    [HttpDelete("connect")]
    public async Task<IActionResult> Disconnect()
    {
        await _openai.DisconnectAsync(HttpContext.RequestAborted);
        return NoContent();
    }
}
