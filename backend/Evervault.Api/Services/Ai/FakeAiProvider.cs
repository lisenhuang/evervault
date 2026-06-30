using System.Text.Json;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// Test/offline provider, used when the env var <c>AI_FAKE=1</c> is set, so the whole feature
/// (keys, failover, model switcher, agent loop, confirmation) can be exercised without real API keys.
/// Key "good" validates; anything else fails (Auth) so failover can be tested. The chat is scripted by
/// trigger phrases in the latest user message.
/// </summary>
public class FakeAiProvider : IAiProvider
{
    private readonly string _name;
    public FakeAiProvider(string name) => _name = name;
    public string Name => _name;

    public Task<(bool Ok, string Message)> ValidateKeyAsync(string rawKey, CancellationToken ct)
        => Task.FromResult(rawKey.Trim() == "good"
            ? (true, "Valid")
            : (false, $"Invalid key (fake provider expects the literal 'good'). Got '{Mask(rawKey)}'."));

    public Task<AiKeyUsage> GetUsageAsync(string rawKey, CancellationToken ct)
    {
        if (rawKey.Trim() != "good")
            throw new AiProviderException(AiErrorKind.Auth, "Invalid key (fake provider expects 'good').");
        var now = DateTimeOffset.UtcNow;
        var nextMidnightUtc = new DateTimeOffset(now.Year, now.Month, now.Day, 0, 0, 0, TimeSpan.Zero).AddDays(1);
        return Task.FromResult(new AiKeyUsage(
            true,
            "Credits: $1.20 used / $10 ($8.80 left) · free tier · free requests today: 20/1000 (980 left)",
            1.20m, 10m, 8.80m, true, null, null,
            DailyLimit: 1000, DailyRemaining: 980, DailyUsed: 20,
            ResetUnixMs: nextMidnightUtc.ToUnixTimeMilliseconds()));
    }

    public Task<IReadOnlyList<AiModelInfo>> ListModelsAsync(string rawKey, CancellationToken ct)
    {
        if (rawKey.Trim() != "good")
            throw new AiProviderException(AiErrorKind.Auth, "Invalid key (fake provider expects 'good').");
        IReadOnlyList<AiModelInfo> models = new List<AiModelInfo>
        {
            new($"{_name}/fake-free", "Fake Free Model", _name, true, 0m, 0m, "Free"),
            new($"{_name}/fake-pro", "Fake Pro Model", _name, false, 0.5m, 1.5m, "$0.5 in / $1.5 out per 1M tokens"),
        };
        return Task.FromResult(models);
    }

    public Task<AiCompletion> CompleteAsync(
        string rawKey, string model, IReadOnlyList<AiChatMessage> messages,
        IReadOnlyList<AiToolSchema> tools, AiGenerationOptions? options, CancellationToken ct)
    {
        if (rawKey.Trim() != "good")
            throw new AiProviderException(AiErrorKind.Auth, "Invalid key (fake provider expects 'good').");

        // Surface the threaded reasoning effort so AI_FAKE=1 E2E can confirm it reaches the provider.
        var effortNote = string.IsNullOrWhiteSpace(options?.ReasoningEffort)
            ? ""
            : $" [reasoning effort: {options!.ReasoningEffort}]";

        // If the previous turn was a tool result, answer with a summary instead of looping.
        var last = messages.LastOrDefault();
        if (last?.Role == "tool")
            return Task.FromResult(new AiCompletion($"Done{effortNote}. Tool '{last.Name}' returned: {Trim(last.Content)}", new List<AiToolCall>()));

        var text = (messages.LastOrDefault(m => m.Role == "user")?.Content ?? "").ToLowerInvariant();

        AiToolCall? Call(string name, object args)
            => new("call_" + Guid.NewGuid().ToString("N"), name, JsonSerializer.Serialize(args));

        if (text.Contains("list memories") || text.Contains("show memories"))
            return Single(Call("list_memories", new { limit = 10 })!);
        if (text.Contains("search "))
            return Single(Call("search_memories", new { query = text.Replace("search ", "").Trim(), k = 5 })!);
        if (text.Contains("create memory") || text.Contains("add memory"))
            return Single(Call("create_memory", new { content = "Memory created via the admin chat (fake).", change_summary = "Create a new memory.", dangerous = false })!);
        if (text.Contains("delete memory"))
            return Single(Call("delete_memory", new { id = 1, change_summary = "Delete memory #1.", dangerous = true })!);
        if (text.Contains("run sql") || text.Contains("select"))
            return Single(Call("sql_query", new { sql = "SELECT count(*) AS memories FROM \"Memories\"" })!);

        return Task.FromResult(new AiCompletion(
            $"This is the fake AI provider (AI_FAKE=1){effortNote}. Try: 'list memories', 'search <text>', 'create memory', 'delete memory', or 'run sql'.",
            new List<AiToolCall>()));
    }

    private static Task<AiCompletion> Single(AiToolCall call)
        => Task.FromResult(new AiCompletion(null, new List<AiToolCall> { call }));

    private static string Trim(string? s) => string.IsNullOrEmpty(s) ? "" : (s.Length > 200 ? s[..200] + "…" : s);
    private static string Mask(string s) => s.Length <= 2 ? "**" : s[..1] + new string('*', s.Length - 2) + s[^1..];
}
