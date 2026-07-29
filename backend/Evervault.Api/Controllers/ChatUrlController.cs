using System.Security.Claims;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

/// <summary>
/// Page reader for the /webapp assistant. The browser's <c>fetch_url</c> tool posts a link here and we fetch
/// it server-side, reducing it to readable markdown the model can answer from.
///
/// It runs on the server rather than in the browser for three reasons: the page's CORS policy would block a
/// direct fetch from the client for most sites; the user's IP and cookies stay out of it; and the URL is
/// untrusted input that needs the SSRF vetting in <see cref="UrlFetchService"/> before anything connects to
/// it. Gated to signed-in webapp users (the <c>ev_user</c> cookie).
/// </summary>
[ApiController]
[Route("chat")]   // behind UsePathBase("/api") → /api/chat/fetchurl
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatUrlController : ControllerBase
{
    private readonly IUrlFetchService _fetch;
    private readonly IErrorReportService _errors;

    public ChatUrlController(IUrlFetchService fetch, IErrorReportService errors)
    {
        _fetch = fetch;
        _errors = errors;
    }

    private int? Uid =>
        int.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var id) ? id : null;

    private string UserAgent => Request.Headers.UserAgent.ToString();

    public record FetchUrlRequest(string? Url);

    /// <summary>Read one page. Expected failures (a dead link, a paywall, a PDF, a blocked address) come back
    /// as 200 with a <c>note</c>, because they are answers the assistant should relay to the user in its own
    /// words rather than errors — the model can then say "that page wouldn't load" and carry on. Only an
    /// unexpected server-side fault produces an EV-coded 502.</summary>
    [HttpPost("fetchurl")]
    public async Task<IActionResult> Fetch([FromBody] FetchUrlRequest req)
    {
        try
        {
            var page = await _fetch.FetchAsync(req.Url ?? "", HttpContext.RequestAborted);
            return Ok(new
            {
                url = page.Url,
                title = page.Title,
                author = page.Author,
                siteName = page.SiteName,
                published = page.Published,
                content = page.Content,
                truncated = page.Truncated,
            });
        }
        catch (UrlFetchException ex)
        {
            // A known, explainable outcome. The message is written to be safe to paraphrase to a user and
            // never names an internal detail.
            return Ok(new { note = ex.Message, failed = true });
        }
        catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
        {
            return new EmptyResult();   // client navigated away — nothing to return
        }
        catch (Exception ex)
        {
            var code = await _errors.CaptureAsync("backend", "url-fetch", Uid, 502,
                "Reading a web page failed unexpectedly.", ex.ToString(), UserAgent);
            return StatusCode(502, new { error = "That page couldn't be opened. Please try again.", referenceCode = code });
        }
    }
}
