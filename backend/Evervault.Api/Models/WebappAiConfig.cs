namespace Evervault.Api.Models;

/// <summary>
/// Single-row (Id = 1) store for the AI models the admin selects for the public /webapp chat: which
/// Gemini models power text, TTS (voice messages), and the realtime live-audio call, plus the default
/// voice. The /webapp is keyless — end users no longer pick models — so it reads this policy from the
/// server (GET /api/chat/ai/config) instead. Mirrors the single-row <see cref="ChatConfig"/> /
/// <see cref="EmbeddingConfig"/> shape. Null fields fall back to <see cref="WebappAiDefaults"/>.
/// </summary>
public class WebappAiConfig
{
    public int Id { get; set; }

    /// <summary>Primary text model id (e.g. a Gemini model, or a ChatGPT model like "gpt-5").</summary>
    public string? TextModel { get; set; }

    /// <summary>Provider for the primary text model: "gemini" | "openai". Null (legacy rows) = "gemini".</summary>
    public string? TextProvider { get; set; }

    /// <summary>Reasoning/thinking effort for the primary text model when it is a ChatGPT model (its own
    /// level set: minimal/low/medium/high/xhigh/…). Null/"auto" = the model's default. Ignored for Gemini.</summary>
    public string? TextReasoning { get; set; }

    /// <summary>Provider for the fallback text model: "gemini" | "openai". Null = no fallback configured.</summary>
    public string? TextFallbackProvider { get; set; }

    /// <summary>Fallback text model id, used when the primary is unavailable. Null = no fallback.</summary>
    public string? TextFallbackModel { get; set; }

    /// <summary>Reasoning/thinking effort for the fallback text model when it is a ChatGPT model.
    /// Null/"auto" = the model's default. Ignored for Gemini.</summary>
    public string? TextFallbackReasoning { get; set; }

    public string? AudioModel { get; set; }
    public string? LiveModel { get; set; }
    public string? DefaultVoice { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>Fallback models/voice for the /webapp when the admin hasn't chosen (or a field is unset).
/// These mirror the historical BYOK client defaults so behavior is unchanged out of the box.</summary>
public static class WebappAiDefaults
{
    public const string TextModel = "gemini-flash-lite-latest";
    public const string AudioModel = "gemini-2.5-flash-preview-tts";
    public const string LiveModel = "gemini-3.1-flash-live-preview";
    public const string Voice = "Kore";
    public const string GeminiProvider = "gemini";

    public static string Text(WebappAiConfig? c) => Or(c?.TextModel, TextModel);
    public static string Audio(WebappAiConfig? c) => Or(c?.AudioModel, AudioModel);
    public static string Live(WebappAiConfig? c) => Or(c?.LiveModel, LiveModel);
    public static string VoiceOf(WebappAiConfig? c) => Or(c?.DefaultVoice, Voice);

    /// <summary>Provider of the primary text model, normalized. Legacy rows (null) are Gemini.</summary>
    public static string TextProviderOf(WebappAiConfig? c) => Norm(c?.TextProvider) ?? GeminiProvider;

    /// <summary>The fallback text leg (provider, model, reasoning), or null when no usable fallback
    /// is configured (a provider without a model is treated as none).</summary>
    public static (string Provider, string Model, string? Reasoning)? TextFallback(WebappAiConfig? c)
    {
        var provider = Norm(c?.TextFallbackProvider);
        if (provider is null || string.IsNullOrWhiteSpace(c?.TextFallbackModel)) return null;
        return (provider, c!.TextFallbackModel!.Trim(), c.TextFallbackReasoning);
    }

    /// <summary>The Gemini text model the <b>keyless browser</b> calls directly (via the pooled-key
    /// proxy) for transcription, file description, TTS, embeddings, and memory extraction. When the
    /// admin's primary choice is a ChatGPT model we hand the browser the first Gemini choice in
    /// primary→fallback order, else the Gemini default — text chat itself then runs server-side
    /// through <c>POST chat/ai/text</c>, which honors the ChatGPT primary. For legacy/Gemini-primary
    /// rows this returns the primary model exactly as before — no behavior change.</summary>
    public static string BrowserText(WebappAiConfig? c)
    {
        if (TextProviderOf(c) == GeminiProvider) return Or(c?.TextModel, TextModel);
        if (Norm(c?.TextFallbackProvider) == GeminiProvider && !string.IsNullOrWhiteSpace(c?.TextFallbackModel))
            return c!.TextFallbackModel!.Trim();
        return TextModel;
    }

    private static string Or(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

    private static string? Norm(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim().ToLowerInvariant();
}
