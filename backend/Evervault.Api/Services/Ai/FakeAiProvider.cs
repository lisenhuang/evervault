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

        // The OAuth "ChatGPT" provider reports plan quota windows (5-hour + weekly) instead of credits.
        if (_name == "openai")
        {
            IReadOnlyList<AiRateWindow> windows = new List<AiRateWindow>
            {
                new("5-hour limit", 34.0, now.AddHours(2).AddMinutes(10).ToUnixTimeMilliseconds()),
                new("Weekly limit", 61.5, now.AddDays(3).AddHours(4).ToUnixTimeMilliseconds()),
            };
            return Task.FromResult(new AiKeyUsage(
                true, "5-hour limit: 34% used  ·  Weekly limit: 61.5% used",
                null, null, null, null, null, null,
                ResetUnixMs: windows[0].ResetUnixMs, Windows: windows));
        }

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

        // The OAuth "ChatGPT" provider advertises per-model reasoning levels (real ones come from the
        // account's /models catalog) so the reasoning selector can be exercised offline.
        if (_name == "openai")
        {
            IReadOnlyList<AiModelInfo> gpt = new List<AiModelInfo>
            {
                new("gpt-5-fake", "GPT-5 (fake)", _name, false, null, null, "Included in ChatGPT plan",
                    new[] { "low", "medium", "high", "xhigh" }, "medium"),
                new("gpt-5-mini-fake", "GPT-5 mini (fake)", _name, false, null, null, "Included in ChatGPT plan",
                    new[] { "low", "medium" }, "low"),
            };
            return Task.FromResult(gpt);
        }

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
        {
            var summary = $"Done{effortNote}. Tool '{last.Name}' returned: {Trim(last.Content)}";
            return Task.FromResult(new AiCompletion(summary, new List<AiToolCall>(), Usage: FakeUsage(messages, summary)));
        }

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

        var help = $"This is the fake AI provider (AI_FAKE=1){effortNote}. Try: 'list memories', 'search <text>', 'create memory', 'delete memory', or 'run sql'.";
        return Task.FromResult(new AiCompletion(help, new List<AiToolCall>(), Usage: FakeUsage(messages, help)));
    }

    // Deterministic ~token counts (roughly chars/4) so AI_FAKE=1 exercises the usage-logging path and the
    // /admin/logs token columns aren't empty offline.
    private static AiUsage FakeUsage(IReadOnlyList<AiChatMessage> messages, string reply)
    {
        var prompt = Math.Max(1, messages.Sum(m => m.Content?.Length ?? 0) / 4);
        var completion = Math.Max(1, reply.Length / 4);
        return new AiUsage(prompt, completion, prompt + completion);
    }

    public Task<(byte[] Pcm, string Mime)> SynthesizeSpeechAsync(
        string rawKey, string model, string text, string voiceName, CancellationToken ct)
    {
        if (rawKey.Trim() != "good")
            throw new AiProviderException(AiErrorKind.Auth, "Invalid key (fake provider expects 'good').");

        // A 0.4s tone; the pitch varies by voice name so different voices are distinguishable offline.
        const int rate = 24000;
        const double seconds = 0.4;
        var freq = 300 + Math.Abs(voiceName.GetHashCode()) % 400; // 300–700 Hz
        var n = (int)(rate * seconds);
        var pcm = new byte[n * 2];
        for (var i = 0; i < n; i++)
        {
            var s = (short)(Math.Sin(2 * Math.PI * freq * i / rate) * 8000);
            pcm[i * 2] = (byte)(s & 0xff);
            pcm[i * 2 + 1] = (byte)((s >> 8) & 0xff);
        }
        return Task.FromResult(((byte[])pcm, "audio/L16;codec=pcm;rate=24000"));
    }

    private static Task<AiCompletion> Single(AiToolCall call)
        => Task.FromResult(new AiCompletion(null, new List<AiToolCall> { call }));

    private static string Trim(string? s) => string.IsNullOrEmpty(s) ? "" : (s.Length > 200 ? s[..200] + "…" : s);
    private static string Mask(string s) => s.Length <= 2 ? "**" : s[..1] + new string('*', s.Length - 2) + s[^1..];
}
