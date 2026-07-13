using Evervault.Api.Data;
using Evervault.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// The ONLY component that decrypts and uses raw keys. Runs an operation against a provider, trying
/// each enabled key in <c>SortOrder</c>; on an auth/quota/transient failure it records the error on
/// that key and advances to the next. When every key fails it throws <see cref="AllKeysFailedException"/>
/// carrying the real provider error message for each key. Non-key errors (Other) propagate immediately.
/// </summary>
public class KeyFailoverRunner
{
    private readonly AppDbContext _db;
    private readonly IDataProtector _protector;
    private readonly IAiProviderFactory _factory;
    private readonly IOpenAiOAuthService _openai;

    public KeyFailoverRunner(AppDbContext db, IDataProtectionProvider dp, IAiProviderFactory factory, IOpenAiOAuthService openai)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.AiKey");
        _factory = factory;
        _openai = openai;
    }

    /// <param name="skip">Rotate the starting key by this many positions before looping (all keys are still
    /// tried, in a rotated order). Lets a caller that already hit a bad key on a previous attempt begin at the
    /// next one — e.g. the /webapp live-token endpoint advances this each time the browser reports the minted
    /// token's key was exhausted. Ignored for the "openai" (OAuth) path.</param>
    public async Task<T> RunAsync<T>(string provider, Func<IAiProvider, string, Task<T>> op, int skip = 0)
    {
        var p = _factory.Get(provider);

        // "openai" isn't key-based — the credential is a rotating OAuth access token from the connected
        // ChatGPT account, not an AiKey list. Fetch/refresh it here instead of looping over keys.
        if (provider == "openai") return await RunOpenAiAsync(p, op);

        var keys = await _db.AiKeys.AsNoTracking()
            .Where(k => k.Provider == provider && k.Enabled)
            .OrderBy(k => k.SortOrder).ThenBy(k => k.Id)
            .ToListAsync();

        if (keys.Count == 0)
            throw new AiProviderException(AiErrorKind.Auth,
                $"No {provider} API keys are configured. Add one in the AI keys section.");

        // Start at position `skip` (wrapping) but still try every key, so callers can advance past a key
        // that failed on an earlier request without losing failover coverage.
        var offset = ((skip % keys.Count) + keys.Count) % keys.Count;
        if (offset > 0) keys = keys.Skip(offset).Concat(keys.Take(offset)).ToList();

        var errors = new List<string>();
        foreach (var k in keys)
        {
            string raw;
            try { raw = _protector.Unprotect(k.KeyEncrypted); }
            catch
            {
                errors.Add($"{k.KeyHint}: stored key could not be decrypted.");
                continue;
            }

            try
            {
                // Always try keys in order; availability is never read from or written to the DB.
                return await op(p, raw);
            }
            catch (AiProviderException ex) when (ex.Kind is AiErrorKind.Auth or AiErrorKind.Quota or AiErrorKind.Transient)
            {
                errors.Add($"{k.KeyHint}: {ex.Message}");
                // try the next key
            }
        }
        throw new AllKeysFailedException(errors);
    }

    /// <summary>OAuth-token path for the "ChatGPT" provider. Passes the current access token (empty when
    /// disconnected — read-only ops like model listing still work); on an auth failure with a real token,
    /// refreshes once and retries. Surfaces a single <see cref="AiProviderException"/>, never AllKeysFailed.</summary>
    private async Task<T> RunOpenAiAsync<T>(IAiProvider p, Func<IAiProvider, string, Task<T>> op)
    {
        if (_factory.IsFake) return await op(p, "good");

        var token = await _openai.TryGetValidAccessTokenAsync(CancellationToken.None);
        try
        {
            return await op(p, token);
        }
        catch (AiProviderException ex) when (ex.Kind == AiErrorKind.Auth && !string.IsNullOrEmpty(token))
        {
            // The token may have just expired or been revoked upstream — refresh once and retry.
            var refreshed = await _openai.ForceRefreshAsync(CancellationToken.None);
            if (string.IsNullOrEmpty(refreshed)) throw;
            return await op(p, refreshed);
        }
    }
}
