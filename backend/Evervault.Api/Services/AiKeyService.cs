using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services.Ai;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Stores AI provider keys (Gemini / OpenRouter) encrypted with Data Protection — same pattern as
/// <see cref="StorageService"/>, one row per key. Raw keys are never returned; the UI only ever sees a
/// masked <c>KeyHint</c>. Validity is checked on demand against the live provider API and returned to the
/// caller — it is NEVER persisted.
/// </summary>
public class AiKeyService : IAiKeyService
{
    private static readonly string[] Providers = { "gemini", "openrouter" };

    private readonly AppDbContext _db;
    private readonly IDataProtector _protector;
    private readonly IAiProviderFactory _factory;

    public AiKeyService(AppDbContext db, IDataProtectionProvider dp, IAiProviderFactory factory)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.AiKey");
        _factory = factory;
    }

    public async Task<AiKeysDto> GetAsync()
    {
        var all = await _db.AiKeys.AsNoTracking().OrderBy(k => k.SortOrder).ThenBy(k => k.Id).ToListAsync();
        return new AiKeysDto(
            all.Where(k => k.Provider == "gemini").Select(Map).ToList(),
            all.Where(k => k.Provider == "openrouter").Select(Map).ToList());
    }

    public async Task<AiKeysDto> AddKeysAsync(string provider, string rawText)
    {
        provider = Normalize(provider);

        var existing = await _db.AiKeys.Where(k => k.Provider == provider).ToListAsync();
        var existingRaw = new HashSet<string>(StringComparer.Ordinal);
        foreach (var k in existing)
        {
            try { existingRaw.Add(_protector.Unprotect(k.KeyEncrypted)); } catch { /* skip undecryptable */ }
        }
        var nextOrder = existing.Count == 0 ? 1 : existing.Max(k => k.SortOrder) + 1;

        var lines = (rawText ?? "")
            .Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .Distinct(StringComparer.Ordinal);

        foreach (var line in lines)
        {
            if (existingRaw.Contains(line)) continue;
            existingRaw.Add(line);
            _db.AiKeys.Add(new AiKey
            {
                Provider = provider,
                KeyEncrypted = _protector.Protect(line),
                KeyHint = Hint(line),
                SortOrder = nextOrder++,
            });
        }
        await _db.SaveChangesAsync();
        return await GetAsync();
    }

    public async Task DeleteAsync(int id)
    {
        var k = await _db.AiKeys.FindAsync(id);
        if (k is null) return;
        _db.AiKeys.Remove(k);
        await _db.SaveChangesAsync();
    }

    public async Task<IReadOnlyList<KeyCheckResult>> CheckAsync(string provider)
    {
        provider = Normalize(provider);
        var keys = await _db.AiKeys.AsNoTracking()
            .Where(k => k.Provider == provider)
            .OrderBy(k => k.SortOrder).ThenBy(k => k.Id)
            .ToListAsync();

        var results = new List<KeyCheckResult>();
        foreach (var k in keys) results.Add(await CheckKeyAsync(k));
        return results;
    }

    public async Task<KeyCheckResult?> CheckOneAsync(int id)
    {
        var k = await _db.AiKeys.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
        return k is null ? null : await CheckKeyAsync(k);
    }

    /// <summary>Validate one key against its provider. Read-only — nothing is written to the DB.</summary>
    private async Task<KeyCheckResult> CheckKeyAsync(AiKey k)
    {
        string raw;
        try { raw = _protector.Unprotect(k.KeyEncrypted); }
        catch { return new KeyCheckResult(k.Id, k.KeyHint, false, "Stored key could not be decrypted."); }

        try
        {
            var provider = _factory.Get(k.Provider);
            var (ok, message) = await provider.ValidateKeyAsync(raw, CancellationToken.None);

            // Only probe embedding when the key itself is valid (a bad key would just fail again).
            bool? embeddingOk = null;
            string? embeddingMessage = null;
            if (ok)
            {
                try
                {
                    var emb = await provider.ValidateEmbeddingAsync(raw, CancellationToken.None);
                    if (emb is { } e)
                    {
                        embeddingOk = e.Ok;
                        embeddingMessage = e.Message;
                    }
                }
                catch (Exception ex)
                {
                    embeddingOk = false;
                    embeddingMessage = ex.Message;
                }
            }

            return new KeyCheckResult(k.Id, k.KeyHint, ok, ok ? "Valid" : message, embeddingOk, embeddingMessage);
        }
        catch (Exception ex)
        {
            return new KeyCheckResult(k.Id, k.KeyHint, false, ex.Message);
        }
    }

    private static AiKeyDto Map(AiKey k) =>
        new(k.Id, k.Provider, k.KeyHint, k.SortOrder, k.Enabled);

    private static string Normalize(string provider)
    {
        var p = (provider ?? "").Trim().ToLowerInvariant();
        if (!Providers.Contains(p))
            throw new ArgumentException($"Unknown provider '{provider}'. Expected 'gemini' or 'openrouter'.");
        return p;
    }

    /// <summary>Masked preview: first 4 + … + last 4 chars. Never enough to reconstruct the key.</summary>
    private static string Hint(string key)
    {
        if (key.Length <= 8) return new string('•', Math.Max(1, key.Length));
        return $"{key[..4]}…{key[^4..]}";
    }
}
