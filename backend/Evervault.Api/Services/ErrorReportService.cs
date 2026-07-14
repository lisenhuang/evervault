using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

public class ErrorReportService : IErrorReportService
{
    // Crockford-style base32: no 0/1/I/L/O/U, so a code read aloud or retyped is unambiguous.
    private const string Alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
    // Client-supplied codes must look like ours; anything else gets replaced with a fresh code.
    private static readonly Regex CodeShape = new("^EV-[A-Z0-9]{4,16}$", RegexOptions.Compiled);
    private static readonly TimeSpan Retention = TimeSpan.FromDays(30);

    private readonly AppDbContext _db;
    private readonly ILogger<ErrorReportService> _log;

    public ErrorReportService(AppDbContext db, ILogger<ErrorReportService> log)
    {
        _db = db;
        _log = log;
    }

    public string NewCode() => "EV-" + new string(RandomNumberGenerator.GetItems<char>(Alphabet, 8));

    public async Task<string> CaptureAsync(
        string source, string area, int? endUserId, int? httpStatus,
        string message, string? detail, string? userAgent = null, string? code = null)
    {
        var normalized = (code ?? "").Trim().ToUpperInvariant();
        if (!CodeShape.IsMatch(normalized)) normalized = NewCode();

        try
        {
            // Log first so the code is greppable in container logs even if the insert fails. Client-
            // supplied message/detail are sanitized (newlines stripped, short-clipped) so a malicious
            // report can't forge or flood log lines. The full untruncated text is kept in the DB row.
            _log.LogWarning("Error report {Code} [{Source}/{Area}] status={Status} user={UserId}: {Message} | {Detail}",
                normalized, source, area, httpStatus, endUserId, LogSafe(message, 200), LogSafe(detail, 300));

            // Idempotent for the client's localStorage queue: a retried code is already stored.
            if (await _db.ErrorReports.AnyAsync(r => r.Code == normalized)) return normalized;

            _db.ErrorReports.Add(new ErrorReport
            {
                Code = normalized,
                Source = Clip(source, 16),
                Area = Clip(area, 40),
                EndUserId = endUserId,
                HttpStatus = httpStatus,
                Message = Clip(message, 2000),
                Detail = detail is null ? null : Clip(detail, 8000),
                UserAgent = string.IsNullOrWhiteSpace(userAgent) ? null : Clip(userAgent, 400),
            });
            await _db.SaveChangesAsync();

            // Opportunistic retention sweep (CreatedAt is indexed) — no background job needed. Run it
            // only occasionally so a burst of failures during an outage doesn't fire a DELETE per
            // request; ~2% amortizes to roughly one sweep per 50 reports.
            if (Random.Shared.Next(50) == 0)
            {
                var cutoff = DateTimeOffset.UtcNow - Retention;
                await _db.ErrorReports.Where(r => r.CreatedAt < cutoff).ExecuteDeleteAsync();
            }
        }
        catch (Exception ex)
        {
            // Never let the report break the failing response path; the warning above still has the code.
            _log.LogError(ex, "Failed to persist error report {Code}", normalized);
        }
        return normalized;
    }

    private static string Clip(string? s, int max)
    {
        s = (s ?? "").Trim();
        return s.Length > max ? s[..max] : s;
    }

    // Collapse newlines/controls to spaces and short-clip, so client-supplied text can't inject or
    // flood log lines. (The stored DB column keeps the full text for the admin lookup.)
    private static string LogSafe(string? s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var collapsed = Regex.Replace(s, @"\s+", " ").Trim();
        return collapsed.Length > max ? collapsed[..max] + "…" : collapsed;
    }
}
