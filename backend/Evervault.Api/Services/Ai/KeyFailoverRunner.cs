using Evervault.Api.Data;
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

    public KeyFailoverRunner(AppDbContext db, IDataProtectionProvider dp, IAiProviderFactory factory)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.AiKey");
        _factory = factory;
    }

    public async Task<T> RunAsync<T>(string provider, Func<IAiProvider, string, Task<T>> op)
    {
        var p = _factory.Get(provider);
        var keys = await _db.AiKeys
            .Where(k => k.Provider == provider && k.Enabled)
            .OrderBy(k => k.SortOrder).ThenBy(k => k.Id)
            .ToListAsync();

        if (keys.Count == 0)
            throw new AiProviderException(AiErrorKind.Auth,
                $"No {provider} API keys are configured. Add one in the AI keys section.");

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
                var result = await op(p, raw);
                // Success — opportunistically clear a previously-recorded failure.
                if (k.Status == "invalid")
                {
                    k.Status = "valid";
                    k.LastError = null;
                    k.LastCheckedAt = DateTimeOffset.UtcNow;
                    await _db.SaveChangesAsync();
                }
                return result;
            }
            catch (AiProviderException ex) when (ex.Kind is AiErrorKind.Auth or AiErrorKind.Quota or AiErrorKind.Transient)
            {
                k.Status = "invalid";
                k.LastError = ex.Message;
                k.LastCheckedAt = DateTimeOffset.UtcNow;
                await _db.SaveChangesAsync();
                errors.Add($"{k.KeyHint}: {ex.Message}");
                // try the next key
            }
        }
        throw new AllKeysFailedException(errors);
    }
}
