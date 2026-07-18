using System.Collections.Concurrent;
using System.Net;
using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// The end-user Gmail surface: the popup OAuth connect flow (start + callback), connection status,
/// disconnect, and the DB-backed email endpoints the chat tools call (digest / search / read).
/// The Gmail REST API itself is only ever called by <see cref="GmailSyncService"/> — these read
/// endpoints serve the local 30-day copy. Scoped to the signed-in end-user (UserCookie); the
/// callback authenticates manually so every outcome renders a friendly self-closing page instead
/// of a bare 401 inside the popup.
/// </summary>
[ApiController]
[Route("chat/gmail")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class GmailController : ControllerBase
{
    private readonly IGmailOAuthService _oauth;
    private readonly AppDbContext _db;
    private readonly GmailSyncService _sync;
    private readonly ILogger<GmailController> _log;

    public GmailController(IGmailOAuthService oauth, AppDbContext db, GmailSyncService sync, ILogger<GmailController> log)
    {
        _oauth = oauth;
        _db = db;
        _sync = sync;
        _log = log;
    }

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    // Digest bounds: keeps the injected block ~250 tokens.
    private const int DigestItems = 8;
    private const int DigestWindowHours = 48;

    // Sliding per-user cap on connect starts (state-mint spam guard). In-memory is fine: single
    // container, and the cost of a lost counter is just extra allowed attempts.
    private static readonly ConcurrentDictionary<int, List<DateTimeOffset>> ConnectStarts = new();
    private const int MaxConnectStartsPerHour = 10;

    private string RedirectUri =>
        $"{Request.Scheme}://{Request.Host}{Request.PathBase}/chat/gmail/oauth/callback";

    // --- OAuth connect flow ---

    /// <summary>Navigated to directly by the popup (window.open inside the click gesture), so the
    /// cookie rides along and there's no popup-blocker race. 302s to Google's consent screen.</summary>
    [HttpGet("connect/start")]
    public async Task<IActionResult> ConnectStart()
    {
        var uid = Uid;
        if (!AllowConnectStart(uid))
            return Page(ok: false, "Too many attempts", "Please wait a bit and try connecting again.");
        if (!await _oauth.IsAvailableAsync(HttpContext.RequestAborted))
            return Page(ok: false, "Not available", "Email connection isn't available right now. Please try again later.");

        var loginHint = User.FindFirst(ClaimTypes.Email)?.Value;
        var url = await _oauth.BuildAuthorizeUrlAsync(uid, RedirectUri, loginHint, HttpContext.RequestAborted);
        return Redirect(url);
    }

    /// <summary>Google redirects the popup here. AllowAnonymous + manual cookie auth: an expired
    /// session must render a friendly page, not a blank 401. Identity comes from the cookie; the
    /// stored per-user <c>state</c> must match (CSRF / session-swap guard). All strings on this page
    /// are static — query values are never reflected into the HTML.</summary>
    [HttpGet("oauth/callback")]
    [AllowAnonymous]
    public async Task<IActionResult> OAuthCallback([FromQuery] string? code, [FromQuery] string? state, [FromQuery] string? error)
    {
        try
        {
            var auth = await HttpContext.AuthenticateAsync(AuthController.Scheme);
            if (auth.Principal?.FindFirst(ClaimTypes.NameIdentifier)?.Value is not { } rawUid
                || !int.TryParse(rawUid, out var uid))
                return Page(ok: false, "Session expired", "Close this window, sign in again, and retry connecting.");

            if (!string.IsNullOrEmpty(error))
                return error == "access_denied"
                    ? Page(ok: false, "Not connected", "You declined the request — nothing was connected.", declined: true)
                    : Page(ok: false, "Something went wrong", "Google couldn't complete the request. Close this window and try again.");
            if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(state))
                return Page(ok: false, "Something went wrong", "The sign-in response was incomplete. Close this window and try again.");

            var result = await _oauth.CompleteAsync(uid, code, state, RedirectUri, HttpContext.RequestAborted);
            if (!result.Ok)
                // scope_missing is a form of decline (they unticked the email checkbox); the rest are
                // errors, so the card shows "try again" rather than "you declined".
                return Page(ok: false, "Not connected", result.ErrorKind switch
                {
                    "scope_missing" => "The email permission checkbox wasn't ticked on Google's screen. Try again and allow it.",
                    "no_refresh_token" => "Google didn't grant ongoing access. Remove this app at myaccount.google.com/permissions, then try again.",
                    "expired" or "no_pending" => "This connect attempt expired. Close this window and try again.",
                    "state_mismatch" => "This connect attempt didn't match — it may have been started elsewhere. Close this window and try again.",
                    _ => "Connecting failed. Close this window and try again.",
                }, declined: result.ErrorKind == "scope_missing");

            _sync.RequestSyncNow(uid);
            var email = WebUtility.HtmlEncode(result.Email ?? "");
            return Page(ok: true, "Connected",
                (email.Length > 0 ? $"{email} is connected. " : "") + "You can close this window.");
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Gmail OAuth callback failed.");
            return Page(ok: false, "Something went wrong", "Connecting failed. Close this window and try again.");
        }
    }

    /// <summary>Connection + sync state for the card, the polling fallback, and the AI status line.</summary>
    [HttpGet("status")]
    public async Task<IActionResult> Status()
    {
        var s = await _oauth.GetStatusAsync(Uid, HttpContext.RequestAborted);
        return Ok(new
        {
            available = s.Available,
            connected = s.Connected,
            email = s.Email,
            connectedAt = s.ConnectedAt,
            initialSyncDone = s.InitialSyncDone,
            lastSyncAt = s.LastSyncAt,
            needsReconnect = s.NeedsReconnect,
        });
    }

    /// <summary>Revoke at Google and delete the connection plus every synced message.</summary>
    [HttpPost("disconnect")]
    public async Task<IActionResult> Disconnect()
    {
        await _oauth.DisconnectAsync(Uid, HttpContext.RequestAborted);
        return NoContent();
    }

    // --- DB-backed email reads (the chat tools) ---

    public record EmailBrief(int Id, string From, string FromName, string Subject, DateTimeOffset Date,
        string Snippet, bool Unread, bool Important, bool Starred);

    /// <summary>The digest injected into the chat's system prompt: recent, non-promotional mail with
    /// the important/unread items first. Hard-capped so the block stays small.</summary>
    [HttpGet("summary")]
    public async Task<IActionResult> Summary()
    {
        var uid = Uid;
        var conn = await _db.GmailConnections.AsNoTracking().FirstOrDefaultAsync(c => c.EndUserId == uid);
        if (conn is null || conn.Status != "connected")
            return Ok(new { connected = false, needsReconnect = conn?.Status == "revoked" });

        var since = DateTimeOffset.UtcNow.AddHours(-DigestWindowHours);
        var recent = _db.GmailMessages.AsNoTracking()
            .Where(m => m.EndUserId == uid && m.InternalDate >= since);

        var items = await recent
            .Where(m => m.Category == null || m.Category != "CATEGORY_PROMOTIONS")
            .OrderByDescending(m => m.IsImportant && m.IsUnread)
            .ThenByDescending(m => m.IsUnread)
            .ThenByDescending(m => m.InternalDate)
            .Take(DigestItems)
            .Select(m => new EmailBrief(m.Id, m.FromAddr, m.FromName, m.Subject, m.InternalDate,
                m.Snippet.Length > 140 ? m.Snippet.Substring(0, 140) + "…" : m.Snippet,
                m.IsUnread, m.IsImportant, m.IsStarred))
            .ToListAsync();

        return Ok(new
        {
            connected = true,
            needsReconnect = false,
            initialSyncDone = conn.InitialSyncDone,
            lastSyncAt = conn.LastSyncAt,
            unread48h = await recent.CountAsync(m => m.IsUnread),
            importantUnread48h = await recent.CountAsync(m => m.IsUnread && m.IsImportant),
            items,
        });
    }

    /// <summary>Keyword search over the local copy (~30 days). Every whitespace-separated term must
    /// match sender, subject, or body (ILIKE containment — the lane that works for CJK too).</summary>
    [HttpGet("search")]
    public async Task<IActionResult> Search([FromQuery] string q = "", [FromQuery] int take = 5)
    {
        var uid = Uid;
        var gate = await GateAsync(uid);
        if (gate is not null) return gate;

        var terms = (q ?? "").Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Take(6).ToArray();
        if (terms.Length == 0) return BadRequest(new { error = "a search query is required" });

        var query = _db.GmailMessages.AsNoTracking().Where(m => m.EndUserId == uid);
        foreach (var term in terms)
        {
            var p = $"%{EscapeLike(term)}%";
            query = query.Where(m =>
                EF.Functions.ILike(m.Subject, p) || EF.Functions.ILike(m.FromAddr, p)
                || EF.Functions.ILike(m.FromName, p) || EF.Functions.ILike(m.BodyText, p));
        }

        var messages = await query
            .OrderByDescending(m => m.InternalDate)
            .Take(Math.Clamp(take, 1, 10))
            .Select(m => new EmailBrief(m.Id, m.FromAddr, m.FromName, m.Subject, m.InternalDate,
                m.Snippet, m.IsUnread, m.IsImportant, m.IsStarred))
            .ToListAsync();

        return Ok(new { messages });
    }

    /// <summary>One message with its extracted plain-text body (already capped at ingest).</summary>
    [HttpGet("messages/{id:int}")]
    public async Task<IActionResult> Read(int id)
    {
        var uid = Uid;
        var gate = await GateAsync(uid);
        if (gate is not null) return gate;

        var m = await _db.GmailMessages.AsNoTracking()
            .FirstOrDefaultAsync(x => x.Id == id && x.EndUserId == uid);
        if (m is null) return NotFound(new { error = "no such message" });

        return Ok(new
        {
            id = m.Id,
            from = m.FromAddr,
            fromName = m.FromName,
            to = m.ToAddr,
            subject = m.Subject,
            date = m.InternalDate,
            unread = m.IsUnread,
            important = m.IsImportant,
            starred = m.IsStarred,
            body = m.BodyText,
        });
    }

    // --- helpers ---

    /// <summary>Shared precondition for the read endpoints: connected, not revoked, first sync done.
    /// Returns null when reads may proceed. 409 bodies are machine-readable for the chat tools.</summary>
    private async Task<IActionResult?> GateAsync(int uid)
    {
        var conn = await _db.GmailConnections.AsNoTracking().FirstOrDefaultAsync(c => c.EndUserId == uid);
        if (conn is null) return Conflict(new { error = "not_connected" });
        if (conn.Status == "revoked") return Conflict(new { error = "reauth_required" });
        if (conn.Status != "connected") return Conflict(new { error = "not_connected" });
        if (!conn.InitialSyncDone)
            return Conflict(new { error = "first_sync_running" });
        return null;
    }

    private static bool AllowConnectStart(int uid)
    {
        var now = DateTimeOffset.UtcNow;
        var list = ConnectStarts.GetOrAdd(uid, _ => new List<DateTimeOffset>());
        lock (list)
        {
            list.RemoveAll(t => now - t > TimeSpan.FromHours(1));
            if (list.Count >= MaxConnectStartsPerHour) return false;
            list.Add(now);
            return true;
        }
    }

    /// <summary>The tiny page the popup lands on. Static strings only (plus an HTML-encoded email on
    /// success); it postMessages a SIGNAL to the opener — which re-fetches status rather than trusting
    /// the payload — then closes itself. <paramref name="declined"/> distinguishes a user decline from
    /// a real error so the card shows the right message (only meaningful when ok is false).</summary>
    private ContentResult Page(bool ok, string heading, string detail, bool declined = false)
    {
        var okJs = ok ? "true" : "false";
        var declinedJs = declined ? "true" : "false";
        var html = $$"""
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>EverVault</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; min-height: 100vh; margin: 0;
         align-items: center; justify-content: center; background: #0b0f1a; color: #e5e7eb; }
  .card { text-align: center; padding: 32px; max-width: 420px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 14px; color: #9ca3af; margin: 0; line-height: 1.5; }
</style></head>
<body><div class="card"><h1>{{heading}}</h1><p>{{detail}}</p></div>
<script>
  try { window.opener && window.opener.postMessage({ type: "ev-gmail-connect", ok: {{okJs}}, declined: {{declinedJs}} }, window.location.origin); } catch (e) {}
  setTimeout(function () { window.close(); }, {{(ok ? "1200" : "4000")}});
</script>
</body></html>
""";
        return Content(html, "text/html");
    }

    private static string EscapeLike(string term) =>
        term.Replace(@"\", @"\\").Replace("%", @"\%").Replace("_", @"\_");
}
