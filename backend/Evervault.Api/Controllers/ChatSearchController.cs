using System.Security.Claims;
using Evervault.Api.Services;
using Evervault.Api.Services.Ai;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

/// <summary>
/// Web search for the /webapp assistant. The browser's <c>search_web</c> tool posts a query here; we run
/// it against Brave with the server-side key (the key never reaches the client) and return the results
/// the model answers from. Gated to signed-in webapp users (the <c>ev_user</c> cookie). The key is never
/// exposed — availability is advertised separately via the <c>webSearch</c> flag on
/// <c>GET /api/chat/ai/config</c>, so an unconfigured deployment simply never offers the tool.
/// </summary>
[ApiController]
[Route("chat")]   // behind UsePathBase("/api") → /api/chat/websearch
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatSearchController : ControllerBase
{
    private readonly IWebSearchService _search;
    private readonly IErrorReportService _errors;

    public ChatSearchController(IWebSearchService search, IErrorReportService errors)
    {
        _search = search;
        _errors = errors;
    }

    private int? Uid =>
        int.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var id) ? id : null;

    private string UserAgent => Request.Headers.UserAgent.ToString();

    public record WebSearchRequest(string? Query, int? Count);

    /// <summary>Run one web search. Always 200 with <c>{ results, note? }</c> so the client tool can relay
    /// a plain payload to the model and never throws — including when the key isn't configured (soft
    /// <c>note</c>, not an error). A genuine upstream failure (rate limit / 5xx / network) returns a
    /// 502 <c>{ error, referenceCode }</c> exactly like the AI proxy.</summary>
    [HttpPost("websearch")]
    public async Task<IActionResult> Search([FromBody] WebSearchRequest req)
    {
        var query = (req.Query ?? "").Trim();
        if (query.Length == 0)
            return Ok(new { results = Array.Empty<WebSearchResult>(), note = "empty query" });

        var count = Math.Clamp(req.Count ?? 5, 1, 10);
        try
        {
            // Provider tiering (dedicated search API → Gemini grounding) lives in the service; from here a
            // search either produces results or doesn't, regardless of which tier served it.
            var results = await _search.SearchAsync(query, count, Uid, HttpContext.RequestAborted);
            return Ok(new { results });
        }
        catch (AiProviderException ex) when (ex.Kind == AiErrorKind.Auth)
        {
            // Not configured / bad key: a config gap, not a failure. Let the assistant gracefully say it
            // can't search right now — never mint an EV code (nothing failed upstream).
            return Ok(new { results = Array.Empty<WebSearchResult>(), note = "web search is not configured" });
        }
        catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
        {
            return new EmptyResult(); // client navigated away / aborted — nothing to return
        }
        catch (Exception ex) when (ex is AiProviderException or AllKeysFailedException or HttpRequestException or IOException or OperationCanceledException)
        {
            // Every configured tier genuinely failed: a bad upstream status (non-Auth), a network-level error
            // (DNS / connection refused / TLS / unreachable, which throw HttpRequestException BEFORE any
            // response), the HttpClient's own timeout (an OperationCanceledException that is NOT a client
            // abort — those were peeled off above), or AllKeysFailed from the grounded fallback exhausting the
            // key pool. EV-coded 502, mirroring the AI proxy.
            var code = await _errors.CaptureAsync("backend", "web-search", Uid, 502,
                "Web search failed on every configured provider.", ex.Message, UserAgent);
            return StatusCode(502, new { error = "Web search is temporarily unavailable. Please try again.", referenceCode = code });
        }
    }
}
