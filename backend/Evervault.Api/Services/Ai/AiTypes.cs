namespace Evervault.Api.Services.Ai;

/// <summary>Neutral chat message exchanged with any provider. The client holds the transcript and
/// re-sends it each turn (stateless backend).</summary>
public record AiChatMessage(
    string Role,                          // "system" | "user" | "assistant" | "tool"
    string? Content = null,
    List<AiToolCall>? ToolCalls = null,   // present on assistant turns that called tools
    string? ToolCallId = null,            // present on tool-result turns
    string? Name = null);                 // tool name (on tool-result turns)

/// <summary>A tool/function call the model wants to make. Arguments stay as a raw JSON string.</summary>
public record AiToolCall(string Id, string Name, string ArgumentsJson);

/// <summary>One model round-trip result: either assistant text, tool calls, or both.</summary>
public record AiCompletion(string? Text, List<AiToolCall> ToolCalls);

/// <summary>A provider-agnostic model entry for the switcher.</summary>
public record AiModelInfo(
    string Id,
    string Name,
    string Provider,
    bool IsFree,
    decimal? PromptPricePerMTok,
    decimal? CompletionPricePerMTok,
    string? PriceLabel);

/// <summary>A model entry for the end-user webapp/app model picker, carrying the raw
/// supportedGenerationMethods so the client can bucket models into text (generateContent),
/// TTS (tts), and live (bidiGenerateContent) — mirroring the browser's REST listing.</summary>
public record WebappModelInfo(string Id, string DisplayName, IReadOnlyList<string> Methods);

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
    long? ResetUnixMs = null);

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

    // --- End-user webapp/app proxy primitives (keys stay server-side; the client sends provider-native
    // request bodies so the mobile app can mirror the browser's @google/genai calls without a key). ---

    /// <summary>Embed one text into a vector of the given dimensionality (for the end-user memory store).
    /// The result is L2-normalized so it shares the browser-embedded vectors' space.</summary>
    Task<float[]> EmbedAsync(string rawKey, string model, string text, int dimensions, CancellationToken ct)
        => throw new AiProviderException(AiErrorKind.Other, "This provider does not support embeddings.");

    /// <summary>One-shot generateContent from a provider-native request body (JSON). Returns the
    /// concatenated text of the first candidate. Used for JSON extraction, transcription, and image
    /// description — the multimodal one-shot calls the browser makes directly today.</summary>
    Task<string> GenerateTextAsync(string rawKey, string model, string requestBodyJson, CancellationToken ct)
        => throw new AiProviderException(AiErrorKind.Other, "This provider does not support generateContent.");

    /// <summary>Streaming generateContent (SSE). After a SUCCESSFUL response status, invokes
    /// <paramref name="onSse"/> with each raw byte chunk from the provider so the caller can relay it
    /// verbatim. On an auth/quota/transient error status it throws BEFORE any chunk is emitted, so
    /// <see cref="KeyFailoverRunner"/> can still advance to the next key without corrupting the stream.</summary>
    Task StreamGenerateAsync(string rawKey, string model, string requestBodyJson,
        Func<ReadOnlyMemory<byte>, CancellationToken, Task> onSse, CancellationToken ct)
        => throw new AiProviderException(AiErrorKind.Other, "This provider does not support streaming.");

    /// <summary>List models with their supportedGenerationMethods so the client can split them into
    /// text / TTS / live buckets.</summary>
    Task<IReadOnlyList<WebappModelInfo>> ListModelDetailsAsync(string rawKey, CancellationToken ct)
        => throw new AiProviderException(AiErrorKind.Other, "This provider does not support model listing.");
}

public interface IAiProviderFactory
{
    IAiProvider Get(string provider);
}
