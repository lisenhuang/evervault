namespace Evervault.Api.Services.Ai;

/// <summary>
/// Server-side constants for premade voice-preview samples. The voice list mirrors the web
/// PREBUILT_VOICES names (web/src/app/webapp/lib/gemini.ts). The sample sentence and model match
/// the web preview so server-rendered samples sound the same as the old client-side ones.
/// </summary>
public static class VoiceSampleOptions
{
    /// <summary>Default TTS model for premade samples. Mirrors the web default audio model.</summary>
    public const string Model = "gemini-3.1-flash-tts-preview";

    /// <summary>The fixed friendly sentence (verbatim from VoicePreviewButton SAMPLE_TEXT).</summary>
    public const string SampleText = "Hi there! This is a quick preview of how this voice sounds.";

    /// <summary>The 30 prebuilt Gemini voice names — the only accepted {voice} values.</summary>
    public static readonly IReadOnlySet<string> Voices = new HashSet<string>(StringComparer.Ordinal)
    {
        "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
        "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
        "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
        "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
        "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
    };

    /// <summary>Deterministic R2 key. The model is part of the path so changing it regenerates.</summary>
    public static string Key(string model, string voice) => $"voice-samples/{model}/{voice}.wav";
}
