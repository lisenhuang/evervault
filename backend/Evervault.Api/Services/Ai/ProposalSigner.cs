using Microsoft.AspNetCore.DataProtection;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// Signs a proposed write action so the confirm step can prove the admin is approving EXACTLY the action
/// the server proposed (same tool, same args), not a tampered one. The signature is a Data-Protection
/// token over "tool|args|expiry"; verification unprotects it and checks the fields match and it hasn't
/// expired. The client cannot forge a token without the key.
/// </summary>
public class ProposalSigner
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(30);
    private const char Sep = '␟';

    private readonly IDataProtector _protector;
    public ProposalSigner(IDataProtectionProvider dp) => _protector = dp.CreateProtector("Evervault.AiProposal");

    public string Sign(string toolName, string argumentsJson)
    {
        var expiry = DateTimeOffset.UtcNow.Add(Ttl).ToUnixTimeSeconds();
        return _protector.Protect($"{toolName}{Sep}{argumentsJson}{Sep}{expiry}");
    }

    public bool Verify(string signature, string toolName, string argumentsJson)
    {
        string payload;
        try { payload = _protector.Unprotect(signature); }
        catch { return false; }

        var parts = payload.Split(Sep);
        if (parts.Length != 3) return false;
        if (!string.Equals(parts[0], toolName, StringComparison.Ordinal)) return false;
        if (!string.Equals(parts[1], argumentsJson, StringComparison.Ordinal)) return false;
        if (!long.TryParse(parts[2], out var expiry)) return false;
        return DateTimeOffset.UtcNow.ToUnixTimeSeconds() <= expiry;
    }
}
