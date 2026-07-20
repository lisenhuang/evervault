using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Loads/saves the Cloudflare R2 (S3) config in the DB, encrypting the secret access key with
/// Data Protection, and validates credentials by listing the bucket. No env vars / no secrets
/// on disk — everything is configured from the /admin UI.
/// </summary>
public class StorageService : IStorageService
{
    private readonly AppDbContext _db;
    private readonly IDataProtector _protector;

    public StorageService(AppDbContext db, IDataProtectionProvider dp)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.StorageSecret");
    }

    public async Task<StorageConfigDto?> GetAsync()
    {
        var c = await _db.StorageConfigs.AsNoTracking().FirstOrDefaultAsync();
        if (c is null) return null;
        return new StorageConfigDto(c.Provider, c.AccountId, c.AccessKeyId, c.Bucket, c.Endpoint,
            c.Region, c.PublicBaseUrl, c.Jurisdiction, !string.IsNullOrEmpty(c.SecretEncrypted), c.UpdatedAt);
    }

    public async Task SaveAsync(StorageConfigInput input)
    {
        var existing = await _db.StorageConfigs.FirstOrDefaultAsync();
        var c = existing ?? new StorageConfig();

        c.Provider = "r2";
        c.AccountId = (input.AccountId ?? "").Trim();
        c.AccessKeyId = (input.AccessKeyId ?? "").Trim();
        c.Bucket = (input.Bucket ?? "").Trim();
        c.Endpoint = string.IsNullOrWhiteSpace(input.Endpoint) ? null : input.Endpoint!.Trim();
        c.Region = string.IsNullOrWhiteSpace(input.Region) ? "auto" : input.Region!.Trim();
        c.PublicBaseUrl = string.IsNullOrWhiteSpace(input.PublicBaseUrl) ? null : input.PublicBaseUrl!.Trim();
        c.Jurisdiction = string.IsNullOrWhiteSpace(input.Jurisdiction) ? null : input.Jurisdiction!.Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(input.Secret))
            c.SecretEncrypted = _protector.Protect(input.Secret);
        c.UpdatedAt = DateTimeOffset.UtcNow;

        if (existing is null) _db.StorageConfigs.Add(c);
        await _db.SaveChangesAsync();
    }

    public async Task<StorageTestResult> TestAsync(StorageConfigInput? input = null)
    {
        string accountId, accessKeyId, bucket, region, secret;
        string? endpoint, jurisdiction;

        if (input is not null)
        {
            accountId = (input.AccountId ?? "").Trim();
            accessKeyId = (input.AccessKeyId ?? "").Trim();
            bucket = (input.Bucket ?? "").Trim();
            endpoint = string.IsNullOrWhiteSpace(input.Endpoint) ? null : input.Endpoint!.Trim();
            region = string.IsNullOrWhiteSpace(input.Region) ? "auto" : input.Region!.Trim();
            jurisdiction = string.IsNullOrWhiteSpace(input.Jurisdiction) ? null : input.Jurisdiction!.Trim().ToLowerInvariant();
            secret = await ResolveSecretAsync(input.Secret);
        }
        else
        {
            var c = await _db.StorageConfigs.AsNoTracking().FirstOrDefaultAsync();
            if (c is null) return new StorageTestResult(false, "No storage configured yet.");
            accountId = c.AccountId; accessKeyId = c.AccessKeyId; bucket = c.Bucket;
            endpoint = c.Endpoint; region = c.Region; jurisdiction = c.Jurisdiction;
            secret = string.IsNullOrEmpty(c.SecretEncrypted) ? "" : _protector.Unprotect(c.SecretEncrypted);
        }

        if (string.IsNullOrWhiteSpace(accountId) || string.IsNullOrWhiteSpace(accessKeyId)
            || string.IsNullOrWhiteSpace(secret) || string.IsNullOrWhiteSpace(bucket))
            return new StorageTestResult(false, "Account ID, Access Key ID, Secret Access Key, and Bucket are all required.");

        try
        {
            using var s3 = BuildClient(accountId, accessKeyId, secret, endpoint, region, jurisdiction);
            await s3.ListObjectsV2Async(new ListObjectsV2Request { BucketName = bucket, MaxKeys = 1 });
        }
        catch (Exception ex)
        {
            return new StorageTestResult(false, $"Connection failed (read/list): {ex.Message}");
        }

        // Voice-sample generation needs PutObject — a read-only token passes the list check but can't
        // write. Probe write access explicitly so misconfigured permissions are caught here, not later.
        try
        {
            using var s3 = BuildClient(accountId, accessKeyId, secret, endpoint, region, jurisdiction);
            using var probe = new MemoryStream(new byte[] { 0 });
            await s3.PutObjectAsync(new PutObjectRequest
            {
                BucketName = bucket,
                Key = "voice-samples/.write-test",
                InputStream = probe,
                ContentType = "application/octet-stream",
                AutoCloseStream = false,
                DisablePayloadSigning = true,
            });
            return new StorageTestResult(true, "Connected to R2 — read and write both OK.");
        }
        catch (Exception ex)
        {
            return new StorageTestResult(false,
                $"Read OK, but WRITE failed — voice samples can't be stored. Give the R2 token “Object Read & Write”. ({ex.Message})");
        }
    }

    private async Task<string> ResolveSecretAsync(string? provided)
    {
        if (!string.IsNullOrWhiteSpace(provided)) return provided!;
        var existing = await _db.StorageConfigs.AsNoTracking().FirstOrDefaultAsync();
        return existing is not null && !string.IsNullOrEmpty(existing.SecretEncrypted)
            ? _protector.Unprotect(existing.SecretEncrypted)
            : "";
    }

    /// <summary>Build an S3 client from the stored config (decrypting the secret), or null if unconfigured.</summary>
    private async Task<(IAmazonS3 Client, string Bucket)?> ResolveClientAsync()
    {
        var c = await _db.StorageConfigs.AsNoTracking().FirstOrDefaultAsync();
        if (c is null || string.IsNullOrWhiteSpace(c.Bucket) || string.IsNullOrWhiteSpace(c.AccountId)
            || string.IsNullOrWhiteSpace(c.AccessKeyId) || string.IsNullOrEmpty(c.SecretEncrypted))
            return null;
        var secret = _protector.Unprotect(c.SecretEncrypted);
        return (BuildClient(c.AccountId, c.AccessKeyId, secret, c.Endpoint, c.Region, c.Jurisdiction), c.Bucket);
    }

    public async Task PutObjectAsync(string key, Stream content, string contentType, CancellationToken ct = default)
    {
        var r = await ResolveClientAsync()
            ?? throw new InvalidOperationException("Storage is not configured.");
        using var client = r.Client;
        await client.PutObjectAsync(new PutObjectRequest
        {
            BucketName = r.Bucket,
            Key = key,
            InputStream = content,
            ContentType = contentType,
            AutoCloseStream = false,
            DisablePayloadSigning = true, // R2 doesn't support streaming SigV4 payload signing
        }, ct);
    }

    public async Task<string?> GetPresignedGetUrlAsync(string key, TimeSpan ttl, CancellationToken ct = default)
    {
        var r = await ResolveClientAsync();
        if (r is null) return null;
        using var client = r.Value.Client;
        return await client.GetPreSignedURLAsync(new GetPreSignedUrlRequest
        {
            BucketName = r.Value.Bucket,
            Key = key,
            Verb = HttpVerb.GET,
            Expires = DateTime.UtcNow.Add(ttl),
        });
    }

    public async Task<byte[]?> GetObjectBytesAsync(string key, CancellationToken ct = default)
    {
        var r = await ResolveClientAsync();
        if (r is null) return null;
        using var client = r.Value.Client;
        try
        {
            using var resp = await client.GetObjectAsync(new GetObjectRequest
            {
                BucketName = r.Value.Bucket,
                Key = key,
            }, ct);
            using var ms = new MemoryStream();
            await resp.ResponseStream.CopyToAsync(ms, ct);
            return ms.ToArray();
        }
        catch (AmazonS3Exception)
        {
            return null; // missing or unreadable — caller falls back to (re)generating.
        }
    }

    public async Task<bool> ObjectExistsAsync(string key, CancellationToken ct = default)
    {
        var r = await ResolveClientAsync();
        if (r is null) return false;
        using var client = r.Value.Client;
        try
        {
            await client.GetObjectMetadataAsync(new GetObjectMetadataRequest
            {
                BucketName = r.Value.Bucket,
                Key = key,
            }, ct);
            return true;
        }
        catch (AmazonS3Exception)
        {
            // Missing — OR the token can't HEAD a missing key (R2 "Object Read & Write" tokens without
            // bucket-list return 403 here). Either way, treat as "not present" so generation proceeds
            // (the real PutObject will surface any genuine write/permission error).
            return false;
        }
    }

    public async Task<IReadOnlyList<string>> ListKeysAsync(string prefix, CancellationToken ct = default)
    {
        var r = await ResolveClientAsync();
        if (r is null) return new List<string>();
        using var client = r.Value.Client;

        var keys = new List<string>();
        string? continuationToken = null;
        do
        {
            var response = await client.ListObjectsV2Async(new ListObjectsV2Request
            {
                BucketName = r.Value.Bucket,
                Prefix = prefix,
                ContinuationToken = continuationToken,
            }, ct);
            if (response.S3Objects is not null)
                keys.AddRange(response.S3Objects.Select(o => o.Key));
            continuationToken = response.IsTruncated == true ? response.NextContinuationToken : null;
        } while (continuationToken is not null);

        return keys;
    }

    public async Task DeleteByPrefixAsync(string prefix, CancellationToken ct = default)
    {
        var r = await ResolveClientAsync();
        if (r is null) return;
        using var client = r.Value.Client;

        string? continuationToken = null;
        do
        {
            var listed = await client.ListObjectsV2Async(new ListObjectsV2Request
            {
                BucketName = r.Value.Bucket,
                Prefix = prefix,
                ContinuationToken = continuationToken,
            }, ct);

            var objects = listed.S3Objects;
            if (objects is { Count: > 0 })
            {
                // DeleteObjects handles up to 1000 keys per request; a page is already ≤1000.
                await client.DeleteObjectsAsync(new DeleteObjectsRequest
                {
                    BucketName = r.Value.Bucket,
                    Objects = objects.Select(o => new KeyVersion { Key = o.Key }).ToList(),
                }, ct);
            }
            continuationToken = listed.IsTruncated == true ? listed.NextContinuationToken : null;
        } while (continuationToken is not null);
    }

    public async Task DeleteObjectAsync(string key, CancellationToken ct = default)
    {
        var r = await ResolveClientAsync();
        if (r is null) return;
        using var client = r.Value.Client;
        try
        {
            await client.DeleteObjectAsync(new DeleteObjectRequest
            {
                BucketName = r.Value.Bucket,
                Key = key,
            }, ct);
        }
        catch (AmazonS3Exception)
        {
            // Already gone (or not visible to this token) — deleting is idempotent from the caller's view.
        }
    }

    private static IAmazonS3 BuildClient(
        string accountId, string accessKeyId, string secret, string? endpoint, string region, string? jurisdiction)
    {
        var url = !string.IsNullOrWhiteSpace(endpoint)
            ? endpoint!
            : $"https://{accountId}.{(jurisdiction == "eu" ? "eu." : "")}r2.cloudflarestorage.com";

        var config = new AmazonS3Config
        {
            ServiceURL = url,
            ForcePathStyle = true,
            AuthenticationRegion = string.IsNullOrWhiteSpace(region) ? "auto" : region,
            // AWS SDK v4 defaults to adding a CRC32 checksum trailer, which makes PutObject use the
            // STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER signing variant — Cloudflare R2 doesn't
            // implement it and rejects the write. Only send a checksum when a request requires one.
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
        };
        return new AmazonS3Client(new BasicAWSCredentials(accessKeyId, secret), config);
    }
}
