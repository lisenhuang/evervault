namespace Evervault.Api.Services;

/// <summary>Storage config returned to the admin UI — the secret is never included (masked).</summary>
public record StorageConfigDto(
    string Provider,
    string AccountId,
    string AccessKeyId,
    string Bucket,
    string? Endpoint,
    string Region,
    string? PublicBaseUrl,
    string? Jurisdiction,
    bool SecretConfigured,
    DateTimeOffset UpdatedAt);

/// <summary>Storage config submitted from the admin UI. Secret is write-only; blank = keep existing.</summary>
public record StorageConfigInput(
    string AccountId,
    string AccessKeyId,
    string? Secret,
    string Bucket,
    string? Endpoint,
    string? Region,
    string? PublicBaseUrl,
    string? Jurisdiction);

public record StorageTestResult(bool Ok, string Message);

public interface IStorageService
{
    Task<StorageConfigDto?> GetAsync();
    Task SaveAsync(StorageConfigInput input);
    Task<StorageTestResult> TestAsync(StorageConfigInput? input = null);
}
