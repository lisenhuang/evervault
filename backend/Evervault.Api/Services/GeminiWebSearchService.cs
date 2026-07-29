using Evervault.Api.Data;
using Evervault.Api.Services.Ai;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Web search backed by Gemini's built-in <c>google_search</c> grounding, using the pooled AI keys that are
/// already configured for chat. This is the FALLBACK path: <see cref="WebSearchService"/> tries the primary
/// search provider first and only lands here when that one is rate-limited, unconfigured, or down.
///
/// Two things about grounding make this more than a thin wrapper:
///
/// 1. <b>Not every key can do it.</b> Grounding is entitled per Google Cloud project, and the newer
///    service-account-bound keys AI Studio now issues ("AQ." prefix) typically land in a fresh unbilled
///    project whose grounding quota is literally zero — they answer 429 with <c>quotaValue: "0"</c>. Only the
///    classic <see cref="EligibleKeyPrefix"/> keys are tried, so a search never burns a round-trip on a key
///    that structurally cannot serve it.
///
/// 2. <b>The source links Google returns are not real URLs.</b> Every grounding chunk's <c>web.uri</c> is an
///    opaque <c>vertexaisearch.cloud.google.com/grounding-api-redirect/…</c> link. Handing one to a user would
///    both break the product rule that the AI stack stays confidential (the hostname names the provider
///    outright) and rot silently, since the redirects are short-lived and Google documents no lifetime. So
///    every link is resolved to its real destination here, and any that cannot be resolved is dropped rather
///    than leaked.
/// </summary>
public class GeminiWebSearchService : IGeminiWebSearchService
{
    /// <summary>Named HttpClient (registered in Program.cs) that does NOT auto-follow redirects — resolving a
    /// grounding link means reading its <c>Location</c>, not fetching the page behind it.</summary>
    public const string HttpClientName = "grounding-redirect";

    /// <summary>The model the grounded search runs on. 2.5 Flash is the cheapest model whose free tier
    /// includes Search grounding (500 grounded requests/day, a quota separate from the model's own RPM/RPD
    /// and shared with 2.5 Flash-Lite).</summary>
    public const string SearchModel = "gemini-2.5-flash";

    /// <summary>Only classic Google API keys are used for grounding — see the class remarks. NOTE: Google has
    /// announced that these "standard" keys stop being accepted by the Gemini API in September 2026, after
    /// which every key in the pool will be an "AQ." auth key and this filter will match nothing. When that
    /// lands, grounding entitlement has to be detected behaviourally (429 + zero quota) instead of by prefix;
    /// until then the prefix is the cheap, exact signal.</summary>
    public const string EligibleKeyPrefix = "AIzaSy";

    /// <summary>Cap on how many redirects are resolved per search. Each costs a round-trip, and the model only
    /// ever needs a handful of citations.</summary>
    private const int MaxSources = 10;

    /// <summary>Per-link budget for resolving a redirect. Deliberately tight: a slow link should cost that one
    /// citation, never the whole search.</summary>
    private static readonly TimeSpan ResolveTimeout = TimeSpan.FromSeconds(4);

    /// <summary>The host grounding redirects live on. A link still pointing here after resolution is
    /// discarded, because the hostname itself identifies the provider. Deliberately NOT all of google.com —
    /// a genuine result on Docs, Maps or Scholar is an ordinary public page that gives nothing away, and
    /// blanket-blocking the domain would silently drop those.</summary>
    private const string RedirectHost = "vertexaisearch.cloud.google.com";

    private readonly AppDbContext _db;
    private readonly KeyFailoverRunner _failover;
    private readonly IHttpClientFactory _http;

    public GeminiWebSearchService(AppDbContext db, KeyFailoverRunner failover, IHttpClientFactory http)
    {
        _db = db;
        _failover = failover;
        _http = http;
    }

    /// <summary>Whether the pool holds any key that could plausibly serve a grounded search. Uses the stored
    /// <c>KeyHint</c> (first 4 + last 4 characters) so the check costs one indexed query and never decrypts
    /// anything — the exact prefix is enforced later, against the real key, inside the failover runner.</summary>
    public async Task<bool> IsAvailableAsync()
    {
        var hintPrefix = EligibleKeyPrefix[..4];   // "AIza" — all the hint exposes
        return await _db.AiKeys.AsNoTracking()
            .AnyAsync(k => k.Provider == "gemini" && k.Enabled && k.KeyHint.StartsWith(hintPrefix));
    }

    public async Task<IReadOnlyList<WebSearchResult>> SearchAsync(
        string query, int count, int? endUserId, CancellationToken ct)
    {
        query = (query ?? "").Trim();
        if (query.Length == 0) return Array.Empty<WebSearchResult>();
        count = Math.Clamp(count, 1, MaxSources);

        var grounded = await _failover.RunAsync(
            "gemini",
            (p, key) => p is GeminiProvider g
                ? g.SearchWebAsync(key, SearchModel, BuildPrompt(query), ct)
                // AI_FAKE swaps in the offline provider, which has no grounding path — return an empty
                // grounded result so a fake-mode search degrades to "no results" instead of throwing.
                : Task.FromResult(new GroundedSearch(null, Array.Empty<GroundedSearchSource>(), null)),
            log: new AiCallContext { Area = "web-search", Model = SearchModel, EndUserId = endUserId },
            usageOf: r => r.Usage,
            keyFilter: k => k.StartsWith(EligibleKeyPrefix, StringComparison.Ordinal));

        return await ToResultsAsync(grounded, count, ct);
    }

    /// <summary>The grounded query. The date is pinned because "today"/"latest" queries are the main reason to
    /// search at all, and the model otherwise resolves them against its training cutoff.</summary>
    private static string BuildPrompt(string query) =>
        $"Search the web and answer this query: {query}\n\n" +
        $"Today's date is {DateTimeOffset.UtcNow:yyyy-MM-dd} (UTC). Answer concisely and factually from what " +
        "you find, keeping the specifics that matter — names, numbers, dates, prices. If the sources " +
        "disagree or the answer is uncertain, say so rather than picking one.";

    /// <summary>Turn a grounded answer into the flat result list the assistant reads. The synthesized answer
    /// rides along as a first entry with no URL, because it is usually more useful than any single snippet;
    /// the cited sources follow with their real, resolved links.</summary>
    private async Task<IReadOnlyList<WebSearchResult>> ToResultsAsync(
        GroundedSearch grounded, int count, CancellationToken ct)
    {
        var results = new List<WebSearchResult>();

        var sources = grounded.Sources.Take(count).ToList();
        var resolved = await Task.WhenAll(sources.Select(s => ResolveAsync(s.Uri, ct)));

        if (!string.IsNullOrWhiteSpace(grounded.Answer))
            results.Add(new WebSearchResult("Search summary", "", grounded.Answer!.Trim()));

        for (var i = 0; i < sources.Count; i++)
        {
            var url = resolved[i];
            if (url is null) continue;   // unresolvable — dropped rather than leaked (see class remarks)
            results.Add(new WebSearchResult(sources[i].Title, url, sources[i].Snippet));
        }

        // A summary with no resolvable links is still a good answer, so it is kept on its own; an empty list
        // (model didn't search, or returned nothing) falls through to the caller's "no results" note.
        // Capped at `count` because the client slices to the same number — without this the summary would
        // occupy a slot and silently push the last source off the end.
        return results.Count > count ? results.Take(count).ToList() : results;
    }

    /// <summary>
    /// Follow a grounding redirect to the page it actually points at. Redirects are read rather than followed
    /// automatically (<see cref="HttpClientName"/> disables auto-redirect) so each hop can be inspected and the
    /// chain stopped the moment it leaves the provider's host — there is no reason to fetch the destination
    /// page itself. Returns null when the real URL cannot be established, which the caller treats as
    /// "drop this citation".
    /// </summary>
    private async Task<string?> ResolveAsync(string redirectUrl, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(redirectUrl)) return null;
        if (!Uri.TryCreate(redirectUrl, UriKind.Absolute, out var current)) return null;
        // Already a real link (Google could change this at any time) — nothing to resolve.
        if (!IsProviderHost(current)) return Https(current);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(ResolveTimeout);
        var client = _http.CreateClient(HttpClientName);

        try
        {
            for (var hop = 0; hop < 4; hop++)
            {
                var next = await LocationOfAsync(client, current, cts.Token);
                if (next is null) return null;
                current = next;
                if (!IsProviderHost(current)) return Https(current);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException)
        {
            // Timed out or unreachable — one bad citation, not a failed search.
        }
        return null;   // still on a provider host after the hop budget: never surfaced
    }

    /// <summary>One redirect hop. HEAD is tried first (no body to download); a host that refuses HEAD is
    /// retried with GET, which is still cheap because the response is abandoned at the headers.</summary>
    private static async Task<Uri?> LocationOfAsync(HttpClient client, Uri url, CancellationToken ct)
    {
        foreach (var method in new[] { HttpMethod.Head, HttpMethod.Get })
        {
            using var req = new HttpRequestMessage(method, url);
            using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            var location = res.Headers.Location;
            if (location is null) continue;
            return location.IsAbsoluteUri ? location : new Uri(url, location);
        }
        return null;
    }

    /// <summary>Whether this is still an unresolved grounding link. Matches on the redirect host, plus the
    /// documented path marker as a hedge in case Google moves the host without changing the scheme.</summary>
    private static bool IsProviderHost(Uri u) =>
        u.Host.Equals(RedirectHost, StringComparison.OrdinalIgnoreCase)
        || u.Host.EndsWith("." + RedirectHost, StringComparison.OrdinalIgnoreCase)
        || u.AbsolutePath.Contains("grounding-api-redirect", StringComparison.OrdinalIgnoreCase);

    /// <summary>Only http(s) links are ever returned — a redirect to any other scheme is discarded.</summary>
    private static string? Https(Uri u) =>
        u.Scheme is "http" or "https" ? u.ToString() : null;
}
