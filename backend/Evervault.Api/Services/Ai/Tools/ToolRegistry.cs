namespace Evervault.Api.Services.Ai.Tools;

/// <summary>
/// The single source of truth for which tools exist and the only execution surface. The agent resolves
/// every model-named tool through here; an unknown/forged name returns null and is rejected — the client
/// can never trigger an arbitrary operation.
/// </summary>
public class ToolRegistry
{
    private readonly Dictionary<string, IAiTool> _tools;

    public ToolRegistry(IEnumerable<IAiTool> tools)
        => _tools = tools.ToDictionary(t => t.Name, StringComparer.Ordinal);

    public IAiTool? Resolve(string name) => _tools.TryGetValue(name, out var t) ? t : null;

    public IReadOnlyList<AiToolSchema> Schemas() =>
        _tools.Values
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .Select(t => new AiToolSchema(t.Name, t.Description, t.ParametersJson))
            .ToList();
}
