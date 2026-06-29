namespace Evervault.Api.Models;

/// <summary>
/// Google "Sign in with Google" / OAuth settings, configured from the /admin UI and stored in the
/// DB. The client secret is held ENCRYPTED (Data Protection), never plaintext. The client ID is
/// public (it is the ID-token audience and is sent to the browser to initialise Google Identity
/// Services). Single-row table (Id = 1).
/// </summary>
public class GoogleAuthConfig
{
    public int Id { get; set; }
    public string ClientId { get; set; } = string.Empty;
    /// <summary>Data Protection ciphertext of the OAuth client secret (never returned to clients).</summary>
    public string ClientSecretEncrypted { get; set; } = string.Empty;
    /// <summary>When false, Google sign-in is disabled everywhere (the safe default).</summary>
    public bool Enabled { get; set; }
    /// <summary>Optional Workspace domain restriction (Google "hd" claim); null = any Google account.</summary>
    public string? AllowedEmailDomain { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
