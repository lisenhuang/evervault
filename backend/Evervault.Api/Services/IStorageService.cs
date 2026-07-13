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

    /// <summary>Upload an object to the configured R2 bucket. Throws if storage isn't configured.</summary>
    Task PutObjectAsync(string key, Stream content, string contentType, CancellationToken ct = default);

    /// <summary>A short-lived presigned GET URL for an object, or null if storage isn't configured.</summary>
    Task<string?> GetPresignedGetUrlAsync(string key, TimeSpan ttl, CancellationToken ct = default);

    /// <summary>The raw object bytes, or null if storage isn't configured or the object is missing.
    /// Lets the API serve small blobs inline from its own origin (no cross-origin redirect), which
    /// some browsers' media loaders can't follow reliably.</summary>
    Task<byte[]?> GetObjectBytesAsync(string key, CancellationToken ct = default);

    /// <summary>True if the object exists in the configured bucket. False if missing OR storage unconfigured.</summary>
    Task<bool> ObjectExistsAsync(string key, CancellationToken ct = default);

    /// <summary>All object keys under a prefix (handles pagination). Empty if storage isn't configured.</summary>
    Task<IReadOnlyList<string>> ListKeysAsync(string prefix, CancellationToken ct = default);

    /// <summary>Delete every object under a prefix (handles pagination + batching). No-op if storage
    /// isn't configured. Used to purge a user's blobs when their account is deleted.</summary>
    Task DeleteByPrefixAsync(string prefix, CancellationToken ct = default);
}
