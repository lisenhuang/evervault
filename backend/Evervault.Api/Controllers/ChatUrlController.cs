using System.Collections.Concurrent;
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

    // --- abuse limits ---
    //
    // This endpoint makes the server fetch an arbitrary public URL on a caller's behalf, from production's
    // egress IP and under its reputation. Sign-in alone is a weak gate (any Google account is accepted unless
    // an allowed domain is configured), so without a ceiling one account could drive a port scanner or a
    // traffic amplifier out of our address. These caps are per-process and in-memory, which suits a
    // single-container deployment and costs nothing to operate; they are sized far above any genuine
    // conversation and only bite on automated abuse.

    private const int MaxPerUserPerMinute = 20;
    private const int MaxConcurrentFetches = 6;

    private static readonly SemaphoreSlim Concurrency = new(MaxConcurrentFetches, MaxConcurrentFetches);
    private static readonly ConcurrentDictionary<int, (long WindowTicks, int Count)> Recent = new();

    /// <summary>Fixed-window counter per user. Returns false when the caller is over the limit.</summary>
    private static bool TryAdmit(int uid)
    {
        var nowWindow = DateTimeOffset.UtcNow.Ticks / TimeSpan.TicksPerMinute;
        var updated = Recent.AddOrUpdate(
            uid,
            _ => (nowWindow, 1),
            (_, prev) => prev.WindowTicks == nowWindow ? (nowWindow, prev.Count + 1) : (nowWindow, 1));

        // Opportunistic sweep so the dictionary can't grow without bound across many users over time.
        if (Recent.Count > 5000)
            foreach (var (k, v) in Recent)
                if (v.WindowTicks < nowWindow) Recent.TryRemove(k, out _);

        return updated.Count <= MaxPerUserPerMinute;
    }

    /// <summary>Read one page. Expected failures (a dead link, a paywall, a PDF, a blocked address) come back
    /// as 200 with a <c>note</c>, because they are answers the assistant should relay to the user in its own
    /// words rather than errors — the model can then say "that page wouldn't load" and carry on. Only an
    /// unexpected server-side fault produces an EV-coded 502.</summary>
    [HttpPost("fetchurl")]
    public async Task<IActionResult> Fetch([FromBody] FetchUrlRequest req)
    {
        // Over the per-user rate: reported as a soft note, like any other "that didn't work", so the
        // assistant says so in its own words instead of the user meeting an error.
        if (Uid is { } uid && !TryAdmit(uid))
            return Ok(new { note = "too many pages have been opened just now; try again in a moment", failed = true });

        if (!await Concurrency.WaitAsync(TimeSpan.FromSeconds(5), HttpContext.RequestAborted))
            return Ok(new { note = "too many pages are being opened at once; try again in a moment", failed = true });

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
        finally
        {
            // Must run on every exit path, including the client-aborted one — a slot leaked here is a slot
            // gone for the life of the process, and six leaks would wedge the endpoint permanently.
            Concurrency.Release();
        }
    }
}
