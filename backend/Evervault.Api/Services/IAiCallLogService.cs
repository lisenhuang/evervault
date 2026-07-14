using Evervault.Api.Models;
using Evervault.Api.Services.Ai;

namespace Evervault.Api.Services;

/// <summary>
/// Persists <see cref="AiCallLog"/> rows for every key-based AI API call. Like the error-report path,
/// capture is best-effort and never throws — logging must never break the AI call it observes.
/// </summary>
public interface IAiCallLogService
{
    /// <summary>Store one call record (fields are clipped to their column limits) and return its new row
    /// id, or null if the write failed. Occasionally sweeps rows older than the 30-day retention window.</summary>
    Task<int?> RecordAsync(AiCallLog log);

    /// <summary>Patch token counts onto an already-recorded row — used by the streaming /webapp proxy,
    /// which only learns usage after it has finished streaming the response to the browser. No-op when
    /// there are no counts to write or the id is unknown; never throws.</summary>
    Task UpdateTokensAsync(int id, AiUsage usage);
}

/// <summary>
/// What a caller tells <see cref="Ai.KeyFailoverRunner"/> about the call it's about to run, so the runner
/// (the one component that knows the key + failover chain) can log it. <see cref="LogId"/> is filled in by
/// the runner after the row is written, letting a streaming caller patch token counts on afterwards.
/// </summary>
public sealed class AiCallContext
{
    /// <summary>What the call is for: admin-chat | webapp-chat | tts | voice-sample | live-token |
    /// models | usage | embed.</summary>
    public string Area { get; init; } = "";

    /// <summary>Target model id where known.</summary>
    public string? Model { get; init; }

    /// <summary>The /webapp end user this call serves, when applicable.</summary>
    public int? EndUserId { get; init; }

    /// <summary>Set by the runner to the recorded row's id (null if the write failed).</summary>
    public int? LogId { get; set; }
}
