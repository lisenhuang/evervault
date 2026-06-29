namespace Evervault.Api.Services;

/// <summary>One stored key as shown to the admin UI — the raw key is never included, only a masked hint.</summary>
public record AiKeyDto(
    int Id,
    string Provider,
    string KeyHint,
    int SortOrder,
    bool Enabled,
    string Status,
    string? LastError,
    DateTimeOffset? LastCheckedAt);

/// <summary>All stored keys, split by provider.</summary>
public record AiKeysDto(IReadOnlyList<AiKeyDto> Gemini, IReadOnlyList<AiKeyDto> OpenRouter);

/// <summary>New keys pasted from the admin UI, one per line.</summary>
public record AddKeysInput(string RawText);

/// <summary>Result of validating a single stored key against its provider.</summary>
public record KeyCheckResult(string KeyHint, bool Ok, string Message);

public record CheckKeysResult(IReadOnlyList<KeyCheckResult> Results);

public interface IAiKeyService
{
    Task<AiKeysDto> GetAsync();
    Task<AiKeysDto> AddKeysAsync(string provider, string rawText);
    Task DeleteAsync(int id);
    Task<IReadOnlyList<KeyCheckResult>> CheckAsync(string provider);
}
