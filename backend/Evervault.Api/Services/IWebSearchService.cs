namespace Evervault.Api.Services;

/// <summary>Web search backed by Gemini's built-in Google Search grounding, run on the shared AI key pool.
/// The fallback tier behind the primary search provider.</summary>
public interface IGeminiWebSearchService
{
    /// <summary>Whether the key pool holds a key that could serve a grounded search. Cheap enough to call on
    /// the config endpoint — it never decrypts a key.</summary>
    Task<bool> IsAvailableAsync();

    /// <summary>Run one grounded search. Throws <see cref="Ai.AiProviderException"/> /
    /// <see cref="Ai.AllKeysFailedException"/> exactly like any other pooled-key call.</summary>
    Task<IReadOnlyList<WebSearchResult>> SearchAsync(string query, int count, int? endUserId, CancellationToken ct);
}

/// <summary>
/// The single entry point the assistant's <c>search_web</c> tool goes through. Owns the provider chain — the
/// dedicated search API first, Gemini grounding second — so the controller stays a thin HTTP shell and the
/// tiering can change without touching it.
/// </summary>
public interface IWebSearchService
{
    /// <summary>Whether ANY tier can currently serve a search. This is the bit the client's <c>webSearch</c>
    /// flag is derived from.</summary>
    Task<bool> IsConfiguredAsync();

    /// <summary>Run a search against the first tier that can serve it. Returns an empty list when no tier is
    /// configured (a config gap, not a failure); throws only when a configured tier genuinely failed.</summary>
    Task<IReadOnlyList<WebSearchResult>> SearchAsync(string query, int count, int? endUserId, CancellationToken ct);
}
