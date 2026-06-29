using System.Text.Json;

namespace Evervault.Api.Services.Ai.Tools;

public enum AiToolKind
{
    /// <summary>Runs automatically, no permission needed (the AI may read/provide any info).</summary>
    Read,
    /// <summary>Modifies the database — never auto-runs; returned as a proposal for the admin to confirm.</summary>
    Write,
}

/// <summary>
/// A capability the admin AI may call. Read tools execute immediately inside the agent loop; Write
/// tools are surfaced as a confirmation proposal and only execute after the admin approves. Tools wrap
/// the existing services — they never duplicate business logic.
/// </summary>
public interface IAiTool
{
    string Name { get; }
    string Description { get; }

    /// <summary>JSON-Schema (string) for the arguments object.</summary>
    string ParametersJson { get; }

    AiToolKind Kind { get; }

    /// <summary>Server safety floor: force the "type CONFIRM" gate regardless of what the model declared.
    /// Can only ESCALATE danger, never lower it.</summary>
    bool ForceDangerous(JsonElement args) => false;

    /// <summary>Human-readable fallback summary if the model didn't supply <c>change_summary</c>.</summary>
    string Summarize(JsonElement args) => Name;

    Task<string> ExecuteAsync(JsonElement args, CancellationToken ct);
}
