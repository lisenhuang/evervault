namespace Evervault.Api.Models;

/// <summary>
/// The embedding policy for end-user chat memory, chosen once in /admin and stored here. It is the
/// shared model + dimension every browser embeds with (using the user's own BYOK key), so stored
/// vectors and query vectors share one vector space. IMMUTABLE once set (<see cref="LockedAt"/> != null):
/// changing the model/dimension would invalidate every existing vector. Single-row table (Id = 1).
/// The server never embeds — it only publishes this policy and stores/searches the client's vectors.
/// </summary>
public class EmbeddingConfig
{
    public int Id { get; set; }
    public string Provider { get; set; } = "gemini";
    public string? Model { get; set; }
    public int Dimensions { get; set; } = 1536;
    /// <summary>Set when the admin first saves; thereafter the config cannot change.</summary>
    public DateTimeOffset? LockedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
