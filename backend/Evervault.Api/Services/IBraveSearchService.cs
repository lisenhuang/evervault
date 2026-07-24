namespace Evervault.Api.Services;

/// <summary>Web-search config returned to the admin UI — the API key is never included (masked to a
/// boolean + hint).</summary>
public record BraveSearchConfigDto(
    bool ApiKeyConfigured,
    string? KeyHint,
    DateTimeOffset UpdatedAt);

/// <summary>Web-search config submitted from the admin UI. ApiKey is write-only; blank = keep existing.</summary>
public record BraveSearchConfigInput(string? ApiKey);

/// <summary>One web-search result the assistant can answer from.</summary>
public record WebSearchResult(string Title, string Url, string Description);

public interface IBraveSearchService
{
    /// <summary>Current web-search config (API key masked). Null when never configured.</summary>
    Task<BraveSearchConfigDto?> GetAsync();

    /// <summary>Save the web-search config (API key encrypted before storage).</summary>
    Task SaveAsync(BraveSearchConfigInput input);

    /// <summary>Whether a usable Brave key is stored — the "can the assistant search the web?" bit.
    /// Never exposes the key itself.</summary>
    Task<bool> IsConfiguredAsync();

    /// <summary>Run a live web search with the stored key. Throws
    /// <see cref="Ai.AiProviderException"/> (Auth when no/invalid key, Quota/Transient/Other for upstream
    /// failures) — the caller decides how to surface it.</summary>
    Task<IReadOnlyList<WebSearchResult>> SearchAsync(string query, int count, CancellationToken ct);
}
