using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services.Ai;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Records one <see cref="AiCallLog"/> per key-based AI API call and mints nothing user-visible — this is
/// pure observability for /admin/logs. Mirrors <see cref="ErrorReportService"/>: every write is wrapped so
/// a logging failure can never break the AI request, and an opportunistic sweep enforces 30-day retention
/// without a background job (CreatedAt is indexed).
/// </summary>
public class AiCallLogService : IAiCallLogService
{
    private static readonly TimeSpan Retention = TimeSpan.FromDays(30);

    private readonly AppDbContext _db;
    private readonly ILogger<AiCallLogService> _log;

    public AiCallLogService(AppDbContext db, ILogger<AiCallLogService> log)
    {
        _db = db;
        _log = log;
    }

    public async Task<int?> RecordAsync(AiCallLog log)
    {
        try
        {
            log.Provider = Clip(log.Provider, 32);
            log.Area = Clip(log.Area, 32);
            log.Outcome = Clip(log.Outcome, 16);
            log.Model = ClipN(log.Model, 128);
            log.KeyHint = ClipN(log.KeyHint, 64);
            log.ErrorKind = ClipN(log.ErrorKind, 16);
            log.ErrorMessage = ClipN(log.ErrorMessage, 2000);
            log.Detail = ClipN(log.Detail, 4000);

            _db.AiCallLogs.Add(log);
            await _db.SaveChangesAsync();

            // Amortized retention sweep — AI calls are far higher-volume than error reports, so run it
            // rarely (~1 in 200 inserts) to keep the DELETE off the hot path during a burst.
            if (Random.Shared.Next(200) == 0)
            {
                var cutoff = DateTimeOffset.UtcNow - Retention;
                await _db.AiCallLogs.Where(r => r.CreatedAt < cutoff).ExecuteDeleteAsync();
            }

            return log.Id;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to persist AI call log ({Provider}/{Area})", log.Provider, log.Area);
            return null;
        }
    }

    public async Task UpdateTokensAsync(int id, AiUsage usage)
    {
        if (usage.PromptTokens is null && usage.CompletionTokens is null && usage.TotalTokens is null) return;
        try
        {
            await _db.AiCallLogs
                .Where(r => r.Id == id)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(r => r.PromptTokens, usage.PromptTokens)
                    .SetProperty(r => r.CompletionTokens, usage.CompletionTokens)
                    .SetProperty(r => r.TotalTokens, usage.TotalTokens));
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to update tokens for AI call log {Id}", id);
        }
    }

    private static string Clip(string? s, int max)
    {
        s = (s ?? "").Trim();
        return s.Length > max ? s[..max] : s;
    }

    private static string? ClipN(string? s, int max)
    {
        if (s is null) return null;
        s = s.Trim();
        return s.Length > max ? s[..max] : s;
    }
}
