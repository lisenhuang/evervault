namespace Evervault.Api.Models;

/// <summary>
/// An end-user of the public /webapp chat, authenticated via "Sign in with Google". Separate from
/// <see cref="AdminUser"/>. We store only identity — no secrets. The Gemini API key used for chat
/// lives only in the user's browser and never reaches the server.
/// </summary>
public class EndUser
{
    public int Id { get; set; }
    /// <summary>Google "sub" claim — the stable, unique account id. Unique index.</summary>
    public string GoogleSub { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? Picture { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset LastLoginAt { get; set; } = DateTimeOffset.UtcNow;
}
