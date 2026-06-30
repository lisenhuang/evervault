namespace Evervault.Api.Models;

/// <summary>
/// Single-row (Id = 1) store for the admin chat box's last selection, so the model switcher
/// remembers the chosen provider/model across reloads. Mirrors the single-row StorageConfig shape.
/// </summary>
public class ChatConfig
{
    public int Id { get; set; }

    /// <summary>"gemini" | "openrouter".</summary>
    public string? SelectedProvider { get; set; }

    public string? GeminiModel { get; set; }
    public string? OpenRouterModel { get; set; }

    /// <summary>Reasoning/thinking effort applied to chat completions, shared across providers:
    /// "auto" (default — send nothing) | "off" | "low" | "medium" | "high". Null (legacy rows) = auto.
    /// Each provider maps it to its own wire format (Gemini thinkingLevel/thinkingBudget, OpenRouter reasoning).</summary>
    public string? ReasoningEffort { get; set; }

    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
