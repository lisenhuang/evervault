namespace Evervault.Api.Models;

/// <summary>
/// One AI provider API call, recorded at the single choke point every key-based call flows through
/// (<see cref="Services.Ai.KeyFailoverRunner"/>). Captures which pooled key handled it (masked hint only —
/// never the raw key), the model, what kind of call it was, how it ended, and token usage where the
/// provider exposes it. Rows are best-effort (logging never breaks the call it observes) and swept after
/// 30 days. Surfaced newest-first in /admin/logs with per-provider/token rollups.
/// </summary>
public class AiCallLog
{
    public int Id { get; set; }

    /// <summary>"gemini" | "openrouter" | "openai".</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>What the call was for: admin-chat | webapp-chat | tts | voice-sample | live-token |
    /// models | usage | embed. Lets the admin filter the noisy metadata calls from real generation.</summary>
    public string Area { get; set; } = string.Empty;

    /// <summary>Model id where known (e.g. "gemini-2.5-flash"); null for calls that don't target one.</summary>
    public string? Model { get; set; }

    /// <summary>Masked preview of the key that handled the call, e.g. "AIza…Q9fK" — the "start…end" the
    /// admin recognises. On total failure, the last key tried. Never the raw key. "ChatGPT (OAuth)" for
    /// the token-based openai path.</summary>
    public string? KeyHint { get; set; }

    /// <summary>How many keys were tried before this call resolved (1 = first key worked; &gt;1 = failover).</summary>
    public int Attempts { get; set; } = 1;

    /// <summary>"ok" | "failed".</summary>
    public string Outcome { get; set; } = "ok";

    /// <summary>On failure: Auth | Quota | Transient | Other (the classification that drove failover).</summary>
    public string? ErrorKind { get; set; }

    /// <summary>On failure: short, masked provider error (per-key hints, never a raw key).</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>Upstream HTTP status where one was seen.</summary>
    public int? HttpStatus { get; set; }

    public int? PromptTokens { get; set; }
    public int? CompletionTokens { get; set; }
    public int? TotalTokens { get; set; }

    /// <summary>Wall-clock duration of the call (all failover attempts included), milliseconds.</summary>
    public int? DurationMs { get; set; }

    /// <summary>The /webapp end user this call served, when applicable (admin calls leave it null).</summary>
    public int? EndUserId { get; set; }

    /// <summary>JSON array of the per-key attempt chain [{hint, error?}] — the full failover story for the
    /// expandable detail row. Null when the first key worked.</summary>
    public string? Detail { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
