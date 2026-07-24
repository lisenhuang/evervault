namespace Evervault.Api.Models;

/// <summary>
/// Web-search (Brave Search API) settings, configured from the /admin UI and stored in the DB. The API
/// key is held ENCRYPTED (Data Protection), never plaintext, and is never returned to any client — only
/// a masked hint and a "configured" boolean are ever exposed. Its presence is what lets the /webapp
/// assistant search the live web. Single-row table (Id = 1), mirroring
/// <see cref="GoogleAuthConfig"/> / <see cref="StorageConfig"/>.
/// </summary>
public class BraveSearchConfig
{
    public int Id { get; set; }
    /// <summary>Data Protection ciphertext of the Brave Search API key (never returned to clients).</summary>
    public string ApiKeyEncrypted { get; set; } = string.Empty;
    /// <summary>Masked preview of the key (e.g. "BSA…7f9c") for the admin UI; safe to display.</summary>
    public string? KeyHint { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
