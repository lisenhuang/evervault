using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// The ONLY component that decrypts and uses raw keys. Runs an operation against a provider, trying
/// each enabled key in <c>SortOrder</c>; on an auth/quota/transient failure it records the error on
/// that key and advances to the next. When every key fails it throws <see cref="AllKeysFailedException"/>
/// carrying the real provider error message for each key. Non-key errors (Other) propagate immediately.
/// A caller whose operation only works on some keys can narrow the pool with a <c>keyFilter</c> predicate
/// without affecting any other call site.
///
/// Because it is also the single point that sees the key identity and the full failover chain, it is where
/// every call is logged (best-effort) to <see cref="AiCallLog"/> when the caller supplies an
/// <see cref="AiCallContext"/>.
/// </summary>
public class KeyFailoverRunner
{
    private readonly AppDbContext _db;
    private readonly IDataProtector _protector;
    private readonly IAiProviderFactory _factory;
    private readonly IOpenAiOAuthService _openai;
    private readonly IAiCallLogService _callLog;

    public KeyFailoverRunner(
        AppDbContext db, IDataProtectionProvider dp, IAiProviderFactory factory,
        IOpenAiOAuthService openai, IAiCallLogService callLog)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.AiKey");
        _factory = factory;
        _openai = openai;
        _callLog = callLog;
    }

    /// <param name="skip">Rotate the starting key by this many positions before looping (all keys are still
    /// tried, in a rotated order). Lets a caller that already hit a bad key on a previous attempt begin at the
    /// next one — e.g. the /webapp live-token endpoint advances this each time the browser reports the minted
    /// token's key was exhausted. Ignored for the "openai" (OAuth) path.</param>
    /// <param name="log">Optional logging context. When supplied, one <see cref="AiCallLog"/> row is recorded
    /// for the call (its id is written back to <see cref="AiCallContext.LogId"/>). Never affects the result.</param>
    /// <param name="usageOf">Optional extractor that pulls token counts out of the successful result, for the
    /// log row. Callers whose result carries no usage (or who patch tokens later, like the streaming proxy)
    /// pass null.</param>
    /// <param name="keyFilter">Optional predicate on the DECRYPTED key, letting a caller restrict failover to
    /// the subset of keys that can actually serve its operation — e.g. web-search grounding only works on
    /// classic "AIza…" Gemini keys, so the search path filters out the newer "AQ." ones rather than burning a
    /// round-trip discovering that per key. Keys that fail the predicate are skipped silently (never logged as
    /// errors, never counted as attempts). When it filters out everything, this throws the same Auth
    /// "no keys configured" exception as an empty key list, so callers treat both alike — except when some
    /// key also failed to decrypt, in which case that more actionable error is reported instead. Null = try
    /// every key, which is what every pre-existing call site does.</param>
    public async Task<T> RunAsync<T>(
        string provider,
        Func<IAiProvider, string, Task<T>> op,
        int skip = 0,
        AiCallContext? log = null,
        Func<T, AiUsage?>? usageOf = null,
        Func<string, bool>? keyFilter = null)
    {
        var sw = Stopwatch.StartNew();
        var p = _factory.Get(provider);

        // "openai" isn't key-based — the credential is a rotating OAuth access token from the connected
        // ChatGPT account, not an AiKey list. Fetch/refresh it here instead of looping over keys.
        if (provider == "openai")
        {
            try
            {
                var result = await RunOpenAiAsync(p, op);
                await RecordOkAsync(log, provider, "ChatGPT (OAuth)", 1, null, usageOf, result, sw);
                return result;
            }
            catch (AiProviderException ex)
            {
                await RecordFailAsync(log, provider, "ChatGPT (OAuth)", 1, null, ex.Kind, ex.Message, sw);
                throw;
            }
        }

        var keys = await _db.AiKeys.AsNoTracking()
            .Where(k => k.Provider == provider && k.Enabled)
            .OrderBy(k => k.SortOrder).ThenBy(k => k.Id)
            .ToListAsync();

        if (keys.Count == 0)
        {
            var ex = new AiProviderException(AiErrorKind.Auth,
                $"No {provider} API keys are configured. Add one in the AI keys section.");
            await RecordFailAsync(log, provider, null, 0, null, ex.Kind, ex.Message, sw);
            throw ex;
        }

        // Start at position `skip` (wrapping) but still try every key, so callers can advance past a key
        // that failed on an earlier request without losing failover coverage.
        var offset = ((skip % keys.Count) + keys.Count) % keys.Count;
        if (offset > 0) keys = keys.Skip(offset).Concat(keys.Take(offset)).ToList();

        var errors = new List<string>();
        var attempts = new List<KeyAttempt>();
        var lastKind = AiErrorKind.Other;
        var eligible = 0;

        foreach (var k in keys)
        {
            string raw;
            try { raw = _protector.Unprotect(k.KeyEncrypted); }
            catch
            {
                errors.Add($"{k.KeyHint}: stored key could not be decrypted.");
                attempts.Add(new KeyAttempt(k.KeyHint, "stored key could not be decrypted."));
                continue;
            }

            // Ineligible for THIS operation (see keyFilter) — not a failure, so it is skipped without an
            // error, an attempt row, or a log entry. It stays perfectly usable for every other call site.
            // Under AI_FAKE the stored keys are placeholders that need not look like real provider keys, so
            // the filter is bypassed — otherwise offline testing would see "no eligible keys".
            if (keyFilter is not null && !_factory.IsFake && !keyFilter(raw)) continue;
            eligible++;

            try
            {
                // Always try keys in order; availability is never read from or written to the DB.
                var result = await op(p, raw);
                attempts.Add(new KeyAttempt(k.KeyHint, null));
                await RecordOkAsync(log, provider, k.KeyHint, attempts.Count, attempts, usageOf, result, sw);
                return result;
            }
            catch (AiProviderException ex) when (ex.Kind is AiErrorKind.Auth or AiErrorKind.Quota or AiErrorKind.Transient)
            {
                errors.Add($"{k.KeyHint}: {ex.Message}");
                attempts.Add(new KeyAttempt(k.KeyHint, ex.Message));
                lastKind = ex.Kind;
                // try the next key
            }
            catch (AiProviderException ex)
            {
                // Non-failover (Other): surfaced immediately. Log it and rethrow unchanged.
                attempts.Add(new KeyAttempt(k.KeyHint, ex.Message));
                await RecordFailAsync(log, provider, k.KeyHint, attempts.Count, attempts, ex.Kind, ex.Message, sw);
                throw;
            }
        }

        // Nothing was attempted and nothing errored — i.e. the filter rejected every key. That is the same
        // situation as an empty key list, so it is surfaced identically and callers need only one "not
        // configured" branch, never an AllKeysFailedException carrying zero errors.
        //
        // `errors.Count == 0` is required, not incidental: a key that failed to DECRYPT also never counts as
        // eligible, and "stored key could not be decrypted" is a far more actionable message for an operator
        // than "no eligible keys". So whenever any such error exists it wins, and this path is skipped.
        if (eligible == 0 && errors.Count == 0)
        {
            var none = new AiProviderException(AiErrorKind.Auth,
                $"No {provider} API keys eligible for this operation are configured.");
            await RecordFailAsync(log, provider, null, 0, null, none.Kind, none.Message, sw);
            throw none;
        }

        await RecordFailAsync(log, provider, keys[^1].KeyHint, attempts.Count, attempts, lastKind,
            string.Join(" | ", errors), sw);
        throw new AllKeysFailedException(errors);
    }

    /// <summary>OAuth-token path for the "ChatGPT" provider. Passes the current access token (empty when
    /// disconnected — read-only ops like model listing still work); on an auth failure with a real token,
    /// refreshes once and retries. Surfaces a single <see cref="AiProviderException"/>, never AllKeysFailed.</summary>
    private async Task<T> RunOpenAiAsync<T>(IAiProvider p, Func<IAiProvider, string, Task<T>> op)
    {
        if (_factory.IsFake) return await op(p, "good");

        var token = await _openai.TryGetValidAccessTokenAsync(CancellationToken.None);
        try
        {
            return await op(p, token);
        }
        catch (AiProviderException ex) when (ex.Kind == AiErrorKind.Auth && !string.IsNullOrEmpty(token))
        {
            // The token may have just expired or been revoked upstream — refresh once and retry.
            var refreshed = await _openai.ForceRefreshAsync(CancellationToken.None);
            if (string.IsNullOrEmpty(refreshed)) throw;
            return await op(p, refreshed);
        }
    }

    // --- logging (best-effort; the service itself never throws) ---

    private readonly record struct KeyAttempt(string Hint, string? Error);

    private async Task RecordOkAsync<T>(
        AiCallContext? ctx, string provider, string keyHint, int attempts,
        List<KeyAttempt>? chain, Func<T, AiUsage?>? usageOf, T result, Stopwatch sw)
    {
        if (ctx is null) return;
        AiUsage? usage = null;
        try { usage = usageOf?.Invoke(result); } catch { /* usage extraction must never break the call */ }

        ctx.LogId = await _callLog.RecordAsync(new AiCallLog
        {
            Provider = provider,
            Area = ctx.Area,
            Model = ctx.Model,
            KeyHint = keyHint,
            Attempts = attempts,
            Outcome = "ok",
            PromptTokens = usage?.PromptTokens,
            CompletionTokens = usage?.CompletionTokens,
            TotalTokens = usage?.TotalTokens,
            DurationMs = (int)sw.ElapsedMilliseconds,
            EndUserId = ctx.EndUserId,
            Detail = ChainJson(chain),
        });
    }

    private async Task RecordFailAsync(
        AiCallContext? ctx, string provider, string? keyHint, int attempts,
        List<KeyAttempt>? chain, AiErrorKind kind, string message, Stopwatch sw)
    {
        if (ctx is null) return;
        ctx.LogId = await _callLog.RecordAsync(new AiCallLog
        {
            Provider = provider,
            Area = ctx.Area,
            Model = ctx.Model,
            KeyHint = keyHint,
            Attempts = attempts,
            Outcome = "failed",
            ErrorKind = kind.ToString(),
            ErrorMessage = message,
            HttpStatus = ParseHttpStatus(message),
            DurationMs = (int)sw.ElapsedMilliseconds,
            EndUserId = ctx.EndUserId,
            Detail = ChainJson(chain),
        });
    }

    // Only worth storing the chain when there was a failover story (more than one key, or any key errored).
    private static string? ChainJson(List<KeyAttempt>? chain)
    {
        if (chain is null || chain.Count == 0) return null;
        if (chain.Count == 1 && chain[0].Error is null) return null;
        return JsonSerializer.Serialize(chain.Select(a => new { hint = a.Hint, error = a.Error }));
    }

    private static readonly Regex HttpStatusRe = new(@"HTTP (\d{3})", RegexOptions.Compiled);

    // The provider error messages lead with "HTTP {code} ..." — cheap to lift the upstream status back out.
    private static int? ParseHttpStatus(string? message)
    {
        if (string.IsNullOrEmpty(message)) return null;
        var m = HttpStatusRe.Match(message);
        return m.Success && int.TryParse(m.Groups[1].Value, out var code) ? code : null;
    }
}
