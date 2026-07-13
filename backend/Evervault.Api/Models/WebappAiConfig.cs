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
    public string? TextModel { get; set; }
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

    public static string Text(WebappAiConfig? c) => Or(c?.TextModel, TextModel);
    public static string Audio(WebappAiConfig? c) => Or(c?.AudioModel, AudioModel);
    public static string Live(WebappAiConfig? c) => Or(c?.LiveModel, LiveModel);
    public static string VoiceOf(WebappAiConfig? c) => Or(c?.DefaultVoice, Voice);

    private static string Or(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}
