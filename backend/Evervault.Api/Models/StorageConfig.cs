namespace Evervault.Api.Models;

/// <summary>
/// Object-storage settings (Cloudflare R2 via the S3 API), configured from the /admin UI and
/// stored in the DB. The secret access key is held ENCRYPTED (Data Protection), never plaintext.
/// Single-row table (Id = 1).
/// </summary>
public class StorageConfig
{
    public int Id { get; set; }
    public string Provider { get; set; } = "r2";
    public string AccountId { get; set; } = string.Empty;
    public string AccessKeyId { get; set; } = string.Empty;
    /// <summary>Data Protection ciphertext of the secret access key (never returned to clients).</summary>
    public string SecretEncrypted { get; set; } = string.Empty;
    public string Bucket { get; set; } = string.Empty;
    /// <summary>Optional override; default derived from AccountId (+ jurisdiction).</summary>
    public string? Endpoint { get; set; }
    public string Region { get; set; } = "auto";
    public string? PublicBaseUrl { get; set; }
    /// <summary>null (default) or "eu" — affects the derived endpoint host.</summary>
    public string? Jurisdiction { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
