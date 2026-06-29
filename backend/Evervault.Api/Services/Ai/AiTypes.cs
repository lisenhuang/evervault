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

/// <summary>A tool the model may call, in provider-agnostic form. <see cref="ParametersJson"/> is a
/// JSON-Schema string describing the arguments.</summary>
public record AiToolSchema(string Name, string Description, string ParametersJson);

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
        CancellationToken ct);
}

public interface IAiProviderFactory
{
    IAiProvider Get(string provider);
}
