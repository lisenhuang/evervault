using System.Runtime.ExceptionServices;
using Evervault.Api.Services.Ai;

namespace Evervault.Api.Services;

/// <summary>
/// Runs a web search against the first tier that can serve it.
///
/// <b>Tier 1 — the dedicated search API</b> (<see cref="IBraveSearchService"/>): a real search index, so it
/// returns page titles, real URLs and snippets directly, and one query costs one cheap REST call.
///
/// <b>Tier 2 — Gemini grounding</b> (<see cref="IGeminiWebSearchService"/>): reuses the AI key pool that is
/// already configured for chat, so it needs no extra key and no extra subscription. It exists because tier 1's
/// free plan is capped at roughly one query per second, which a burst of tool calls trips easily — a
/// rate-limited primary should degrade to a slower search, not to no search at all.
///
/// Tier 2 is tried whenever tier 1 does not produce results: an outright failure (rate limit, 5xx, network),
/// no key configured, or a successful-but-empty result set. That last case matters because a rate-limited or
/// misconfigured upstream can answer 200-with-nothing, and "search found nothing" is a much worse answer than
/// simply asking the other provider.
/// </summary>
public class WebSearchService : IWebSearchService
{
    private readonly IBraveSearchService _brave;
    private readonly IGeminiWebSearchService _gemini;
    private readonly ILogger<WebSearchService> _log;

    public WebSearchService(
        IBraveSearchService brave, IGeminiWebSearchService gemini, ILogger<WebSearchService> log)
    {
        _brave = brave;
        _gemini = gemini;
        _log = log;
    }

    public async Task<bool> IsConfiguredAsync() =>
        await _brave.IsConfiguredAsync() || await _gemini.IsAvailableAsync();

    public async Task<IReadOnlyList<WebSearchResult>> SearchAsync(
        string query, int count, int? endUserId, CancellationToken ct)
    {
        query = (query ?? "").Trim();
        if (query.Length == 0) return Array.Empty<WebSearchResult>();

        Exception? primaryFailure = null;
        try
        {
            var results = await _brave.SearchAsync(query, count, ct);
            if (results.Count > 0) return results;
            _log.LogInformation("Web search: primary returned no results, trying the grounded fallback.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;   // the caller went away — not a provider failure, and nothing to fall back to
        }
        catch (Exception ex) when (ex is AiProviderException or HttpRequestException or IOException or OperationCanceledException)
        {
            // Includes the Auth "no key configured" case, so a deployment with only AI keys and no search
            // subscription goes straight to grounding.
            primaryFailure = ex;
            _log.LogWarning(ex, "Web search: primary provider failed, trying the grounded fallback.");
        }

        try
        {
            return await _gemini.SearchAsync(query, count, endUserId, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is AiProviderException or AllKeysFailedException or HttpRequestException or IOException or OperationCanceledException)
        {
            _log.LogWarning(ex, "Web search: grounded fallback failed as well.");

            // The primary SUCCEEDED and simply found nothing — the fallback was an opportunistic second
            // opinion, so its failure must not turn a legitimate "no results" into an error (or, when it
            // failed with Auth, into a bogus "web search is not configured").
            if (primaryFailure is null) return Array.Empty<WebSearchResult>();

            // Both tiers are genuinely out. Surface the PRIMARY failure: it is the more diagnostic of the two
            // (an expired key, a rate limit) where the fallback's is usually just "no eligible keys".
            // Rethrown via ExceptionDispatchInfo so the original stack trace survives into the error report.
            ExceptionDispatchInfo.Capture(primaryFailure).Throw();
            throw;   // unreachable — keeps the compiler's definite-assignment analysis happy
        }
    }
}
