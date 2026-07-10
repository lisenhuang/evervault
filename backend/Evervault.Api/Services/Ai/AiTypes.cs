namespace Evervault.Api.Services.Ai;

/// <summary>Neutral chat message exchanged with any provider. The client holds the transcript and
/// re-sends it each turn (stateless backend).</summary>
public record AiChatMessage(
    string Role,                          // "system" | "user" | "assistant" | "tool"
    string? Content = null,
    List<AiToolCall>? ToolCalls = null,   // present on assistant turns that called tools
    string? ToolCallId = null,            // present on tool-result turns
    string? Name = null,                  // tool name (on tool-result turns)
    string? ProviderState = null);        // opaque provider-only state round-tripped via the client
                                          // transcript (OpenAI: reasoning items to re-send under store:false)

/// <summary>A tool/function call the model wants to make. Arguments stay as a raw JSON string.</summary>
public record AiToolCall(string Id, string Name, string ArgumentsJson);

/// <summary>One model round-trip result: either assistant text, tool calls, or both. <see cref="ProviderState"/>
/// is optional opaque data the provider needs echoed on the next turn (see <see cref="AiChatMessage"/>).</summary>
public record AiCompletion(string? Text, List<AiToolCall> ToolCalls, string? ProviderState = null);

/// <summary>A provider-agnostic model entry for the switcher. <see cref="ReasoningLevels"/> (when the
/// provider advertises them, e.g. ChatGPT) lets the UI offer only the effort levels this model supports.</summary>
public record AiModelInfo(
    string Id,
    string Name,
    string Provider,
    bool IsFree,
    decimal? PromptPricePerMTok,
    decimal? CompletionPricePerMTok,
    string? PriceLabel,
    IReadOnlyList<string>? ReasoningLevels = null,
    string? DefaultReasoningLevel = null);

/// <summary>A tool the model may call, in provider-agnostic form. <see cref="ParametersJson"/> is a
/// JSON-Schema string describing the arguments.</summary>
public record AiToolSchema(string Name, string Description, string ParametersJson);

/// <summary>Per-call generation tuning, provider-agnostic. Today only carries reasoning effort;
/// add temperature/max-tokens/etc. here later. <see cref="ReasoningEffort"/> is one of
/// "auto" | "off" | "low" | "medium" | "high" (null/"auto" → providers send nothing special).</summary>
public record AiGenerationOptions(string? ReasoningEffort = null);

/// <summary>Credit/quota usage for a key, where the provider exposes it (OpenRouter does; Gemini does not).
/// The Daily*/ResetUnixMs fields come from rate-limit response headers (best-effort) and describe the
/// free-model daily request allowance.</summary>
public record AiKeyUsage(
    bool Supported,
    string? Summary,
    decimal? Usage,
    decimal? Limit,
    decimal? Remaining,
    bool? IsFreeTier,
    string? RateLimit,
    string? ResetNote,
    long? DailyLimit = null,
    long? DailyRemaining = null,
    long? DailyUsed = null,
    long? ResetUnixMs = null,
    IReadOnlyList<AiRateWindow>? Windows = null);

/// <summary>One rolling rate-limit window (e.g. ChatGPT's 5-hour and weekly quotas): how much of the
/// window is consumed and when it resets. <see cref="ResetUnixMs"/> is epoch milliseconds.</summary>
public record AiRateWindow(string Label, double UsedPercent, long? ResetUnixMs);

public enum AiErrorKind { Auth, Quota, Transient, Other }

/// <summary>A typed provider error. <see cref="Kind"/> drives key failover (Auth/Quota/Transient
/// advance to the next key; Other is surfaced immediately).</summary>
public class AiProviderException : Exception
{
    public AiErrorKind Kind { get; }
    public AiProviderException(AiErrorKind kind, string message) : base(message) => Kind = kind;
}

/// <summary>Thrown when every key for a provider failed. Carries one message per key.</summary>
public class AllKeysFailedException : Exception
{
    public IReadOnlyList<string> Errors { get; }
    public AllKeysFailedException(IReadOnlyList<string> errors)
        : base("All API keys failed.") => Errors = errors;
}

/// <summary>A chat/model provider (OpenRouter, Gemini, …). Implementations are stateless and take the
/// raw key per call — the <see cref="KeyFailoverRunner"/> owns key selection.</summary>
public interface IAiProvider
{
    string Name { get; }
    Task<(bool Ok, string Message)> ValidateKeyAsync(string rawKey, CancellationToken ct);
    Task<IReadOnlyList<AiModelInfo>> ListModelsAsync(string rawKey, CancellationToken ct);
    /// <summary>List models for a purpose: "chat" (generateContent) or "embedding" (embedContent).
    /// Defaults to the chat list for providers that don't distinguish.</summary>
    Task<IReadOnlyList<AiModelInfo>> ListModelsAsync(string rawKey, string kind, CancellationToken ct)
        => ListModelsAsync(rawKey, ct);
    Task<AiKeyUsage> GetUsageAsync(string rawKey, CancellationToken ct);
    Task<AiCompletion> CompleteAsync(
        string rawKey,
        string model,
        IReadOnlyList<AiChatMessage> messages,
        IReadOnlyList<AiToolSchema> tools,
        AiGenerationOptions? options,
        CancellationToken ct);

    /// <summary>Synthesize speech for the given text+voice. Returns raw PCM bytes and the audio mime
    /// (e.g. "audio/L16;codec=pcm;rate=24000"). Default: the provider has no TTS — throws Other so
    /// <see cref="KeyFailoverRunner"/> surfaces it immediately instead of retrying every key.</summary>
    Task<(byte[] Pcm, string Mime)> SynthesizeSpeechAsync(
        string rawKey, string model, string text, string voiceName, CancellationToken ct)
        => throw new AiProviderException(AiErrorKind.Other, "This provider does not support TTS.");
}

public interface IAiProviderFactory
{
    IAiProvider Get(string provider);

    /// <summary>True when AI_FAKE=1 — every provider resolves to the offline <see cref="FakeAiProvider"/>.
    /// Lets other seams (e.g. <see cref="KeyFailoverRunner"/>) skip real credential lookups.</summary>
    bool IsFake { get; }
}
