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

    // Last-seen visitor IP + geolocation, read from Cloudflare edge headers at login (see CloudflareGeo).
    // All nullable/best-effort: only CF-Connecting-IP + CF-IPCountry arrive by default; the finer fields
    // need Cloudflare's "Add visitor location headers" managed transform enabled.
    public string? LastIp { get; set; }
    public string? LastCountry { get; set; }
    public string? LastCity { get; set; }
    public string? LastRegion { get; set; }
    public string? LastContinent { get; set; }
    public double? LastLatitude { get; set; }
    public double? LastLongitude { get; set; }
    public string? LastPostalCode { get; set; }
    public string? LastTimezone { get; set; }

    // Per-surface response-style preference for the /webapp chat, so a signed-in user's choice follows
    // their account across devices/browsers (served/updated via chat/settings). Each is one of
    // concise|friendly|detailed|professional|playful, or null = "default" (keep the surface's built-in
    // tone — the zero-config baseline). A literal "default" or any unknown value is stored as null, so
    // null is the single source of "use the built-in tone" — mirroring the client's "empty = default".
    // Additive & nullable: future scalar prefs (voice, memory toggle) should join here under the same
    // chat/settings endpoint rather than a new table, until prefs genuinely balloon.
    public string? TextStyle { get; set; }
    public string? VoiceStyle { get; set; }
    public string? LiveStyle { get; set; }
}
