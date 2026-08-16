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

    /// <summary>Thinking level for the realtime-call Live model: "minimal" | "low" | "medium" | "high".
    /// Null/unrecognized = send no thinkingConfig, i.e. the model's own default (Gemini Live defaults to
    /// minimal, for latency). Applied browser-side on the Live socket's <c>thinkingConfig.thinkingLevel</c>.
    /// Raising it buys deeper tool/multi-step reasoning at the cost of time-to-first-audio, which on a
    /// hands-free call is silence — so the default deliberately stays unset.</summary>
    public string? LiveReasoning { get; set; }

    /// <summary>Thinking level for the voice-message Live model, same value set as <see cref="LiveReasoning"/>.
    /// Independent of it (not inherited like <see cref="VoiceLiveModel"/> is) so the admin can afford a
    /// slower, deeper answer on a voice message — where the user is already waiting — while keeping the
    /// realtime call snappy. Null = the model's default.</summary>
    public string? VoiceLiveReasoning { get; set; }

    /// <summary>How long a live voice call may sit in user silence before it auto-hangs-up, in seconds.
    /// A Live socket bills for the whole time it's open, so this caps an abandoned call. 0 = never hang up
    /// (the call runs until the user ends it). Null (legacy rows) = <see cref="WebappAiDefaults.LiveIdleSeconds"/>.</summary>
    public int? LiveIdleTimeoutSeconds { get; set; }

    /// <summary>The Gemini Live model used to answer /webapp voice messages (audio-in / audio-out) when
    /// <see cref="VoiceMode"/> is "live". Null = inherit the realtime-call <see cref="LiveModel"/>, then the
    /// <see cref="WebappAiDefaults.LiveModel"/> default. Must be a Live-API model (same list as the call).</summary>
    public string? VoiceLiveModel { get; set; }

    /// <summary>How /webapp voice messages are answered: "live" = one Gemini Live session (fast — audio + text
    /// in a single call, with automatic fallback to TTS on failure); "tts" = the legacy record→transcribe→
    /// reply→synthesize pipeline. Null (legacy rows) = <see cref="WebappAiDefaults.VoiceMode"/> ("live").</summary>
    public string? VoiceMode { get; set; }

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

    /// <summary>Default voice-message answer mode. "live" = the Gemini Live audio-in/audio-out path (with the
    /// client falling back to TTS on failure); the alternative is "tts" (the legacy synthesis pipeline).</summary>
    public const string VoiceMode = "live";

    /// <summary>Default auto-hang-up window for an idle live call (1 minute), matching the value the
    /// client hard-coded before this became configurable — so unset rows behave exactly as before.</summary>
    public const int LiveIdleSeconds = 60;

    /// <summary>Upper bound the admin may set (2 hours). Guards against a typo leaving a billed Live
    /// socket open effectively forever; "never" is expressed as 0, not a huge number.</summary>
    public const int MaxLiveIdleSeconds = 7200;

    /// <summary>Lower bound (30s). Anything shorter would cut off a user mid-thought.</summary>
    public const int MinLiveIdleSeconds = 30;

    /// <summary>The thinking levels a Gemini 3.x Live model accepts, shallowest first. The client maps these
    /// onto the Live socket's <c>thinkingConfig.thinkingLevel</c> (MINIMAL/LOW/MEDIUM/HIGH). "auto" is not a
    /// member: it's expressed as null, meaning "send no thinkingConfig at all".</summary>
    public static readonly string[] LiveReasoningLevels = ["minimal", "low", "medium", "high"];

    public static string Text(WebappAiConfig? c) => Or(c?.TextModel, TextModel);
    public static string Audio(WebappAiConfig? c) => Or(c?.AudioModel, AudioModel);
    public static string Live(WebappAiConfig? c) => Or(c?.LiveModel, LiveModel);
    public static string VoiceOf(WebappAiConfig? c) => Or(c?.DefaultVoice, Voice);

    /// <summary>The Live model for voice messages: the admin's voice-chat choice, else the realtime-call Live
    /// model, else the default. All come from the same Live-API model list.</summary>
    public static string VoiceLive(WebappAiConfig? c) => Or(c?.VoiceLiveModel, Live(c));

    /// <summary>The voice-message answer mode, normalized to "live" | "tts". Legacy/unset rows default to
    /// "live" (the client still auto-falls-back to TTS if a Live session fails).</summary>
    public static string VoiceModeOf(WebappAiConfig? c) => Norm(c?.VoiceMode) == "tts" ? "tts" : VoiceMode;

    /// <summary>The realtime call's thinking level, or null for the model's default.</summary>
    public static string? LiveReasoningOf(WebappAiConfig? c) => NormalizeLiveReasoning(c?.LiveReasoning);

    /// <summary>The voice-message Live thinking level, or null for the model's default.</summary>
    public static string? VoiceLiveReasoningOf(WebappAiConfig? c) => NormalizeLiveReasoning(c?.VoiceLiveReasoning);

    /// <summary>Coerce a thinking level to one of <see cref="LiveReasoningLevels"/>, else null. Anything
    /// unknown — "auto", "", a typo, a level a future model drops — becomes null rather than being kept:
    /// a bad value on a Live socket is rejected at setup, which fails the whole call rather than just the
    /// setting, so an unrecognized level must degrade to "send nothing".</summary>
    public static string? NormalizeLiveReasoning(string? value)
    {
        var v = Norm(value);
        return v is not null && LiveReasoningLevels.Contains(v) ? v : null;
    }

    /// <summary>The idle auto-hang-up window in seconds, clamped to the allowed range. 0 means never.</summary>
    public static int LiveIdle(WebappAiConfig? c)
    {
        var v = c?.LiveIdleTimeoutSeconds ?? LiveIdleSeconds;
        if (v <= 0) return 0;
        return Math.Clamp(v, MinLiveIdleSeconds, MaxLiveIdleSeconds);
    }

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
