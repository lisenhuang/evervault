namespace Evervault.Api.Models;

/// <summary>
/// One AI provider API key (Gemini or OpenRouter). The raw key is encrypted with Data Protection
/// and never returned to clients — only a masked <see cref="KeyHint"/> is exposed. One row per key so
/// each key can carry its own validity status and participate in failover ordering.
/// </summary>
public class AiKey
{
    public int Id { get; set; }

    /// <summary>"gemini" | "openrouter".</summary>
    public string Provider { get; set; } = "";

    /// <summary>Data Protection ciphertext of the raw key. Never returned to the UI.</summary>
    public string KeyEncrypted { get; set; } = "";

    /// <summary>Masked preview for the UI, e.g. "AIza…Q9fK". Safe to display.</summary>
    public string KeyHint { get; set; } = "";

    /// <summary>Failover order — lower numbers are tried first.</summary>
    public int SortOrder { get; set; }

    /// <summary>Soft on/off without deleting the key.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>"unknown" | "valid" | "invalid" — last known validation/usage result.</summary>
    public string Status { get; set; } = "unknown";

    /// <summary>Last validation or failover error message (null when healthy).</summary>
    public string? LastError { get; set; }

    public DateTimeOffset? LastCheckedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
