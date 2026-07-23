using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Client-side error reports from the /webapp chat. When a request never reaches the backend (e.g. the
/// origin was down and Cloudflare answered with its own 502 page), the browser mints the reference code
/// it shows the user and posts the full detail here — retrying from a localStorage queue until it lands —
/// so the code is searchable in /admin/errors even for failures the server never saw.
/// Gated to signed-in webapp users (the ev_user cookie).
/// </summary>
[ApiController]
[Route("chat/errors")]   // behind UsePathBase("/api") → POST /api/chat/errors
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatErrorsController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IErrorReportService _errors;

    public ChatErrorsController(AppDbContext db, IErrorReportService errors)
    {
        _db = db;
        _errors = errors;
    }

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    // A user retrying a broken chat produces a handful of reports, not hundreds — cap the rest.
    private const int MaxReportsPerUserPerHour = 30;

    public record ErrorReportInput(string? Code, string? Area, int? HttpStatus, string? Message, string? Detail);

    /// <summary>Store one client-captured error. Idempotent per code, so queue retries are safe.</summary>
    [HttpPost]
    [RequestSizeLimit(32_768)]
    public async Task<IActionResult> Report([FromBody] ErrorReportInput req, CancellationToken ct)
    {
        var uid = Uid;
        var since = DateTimeOffset.UtcNow.AddHours(-1);
        var recent = await _db.ErrorReports.AsNoTracking()
            .CountAsync(r => r.EndUserId == uid && r.Source == "client" && r.CreatedAt >= since, ct);
        if (recent >= MaxReportsPerUserPerHour)
            return StatusCode(429, new { error = "Too many error reports. Please try again later." });

        var result = await _errors.TryCaptureAsync(
            "client", req.Area ?? "", uid, req.HttpStatus,
            req.Message ?? "", req.Detail, Request.Headers.UserAgent.ToString(), req.Code);

        // The write was swallowed (transient DB failure) — don't ack it as stored, or the client drops
        // it from its retry queue and the shown code is lost. A 5xx keeps the client retrying (it treats
        // 5xx as retryable) until the row actually lands.
        if (!result.Persisted)
            return StatusCode(503, new { error = "Could not store the report. Please try again.", code = result.Code });

        return Ok(new { code = result.Code });
    }
}
