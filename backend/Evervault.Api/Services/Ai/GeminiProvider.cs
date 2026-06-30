using System.Net;
using System.Text;
using System.Text.Json;

namespace Evervault.Api.Services.Ai;

/// <summary>Google AI Studio (Generative Language API) provider. Lists models (no pricing exposed),
/// validates keys, and runs generateContent with function calling. Translates the neutral message /
/// tool shapes to Gemini's contents/parts/functionCall format.</summary>
public class GeminiProvider : IAiProvider
{
    private const string Base = "https://generativelanguage.googleapis.com";
    private readonly IHttpClientFactory _http;

    public GeminiProvider(IHttpClientFactory http) => _http = http;

    public string Name => "gemini";

    private HttpRequestMessage Req(HttpMethod method, string path, string key)
    {
        var r = new HttpRequestMessage(method, Base + path);
        r.Headers.TryAddWithoutValidation("x-goog-api-key", key);
        return r;
    }

    public async Task<(bool Ok, string Message)> ValidateKeyAsync(string rawKey, CancellationToken ct)
    {
        var client = _http.CreateClient();
        using var res = await client.SendAsync(Req(HttpMethod.Get, "/v1beta/models", rawKey), ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (res.IsSuccessStatusCode) return (true, "Valid");
        return (false, ExtractError(body, res.StatusCode));
    }

    public Task<AiKeyUsage> GetUsageAsync(string rawKey, CancellationToken ct)
        => Task.FromResult(new AiKeyUsage(false, "Gemini does not expose usage/quota via its API.", null, null, null, null, null, null));

    public Task<IReadOnlyList<AiModelInfo>> ListModelsAsync(string rawKey, CancellationToken ct)
        => ListModelsAsync(rawKey, "chat", ct);

    public async Task<IReadOnlyList<AiModelInfo>> ListModelsAsync(string rawKey, string kind, CancellationToken ct)
    {
        // "embedding" → models that support embedContent; otherwise chat (generateContent).
        var wantMethod = string.Equals(kind, "embedding", StringComparison.OrdinalIgnoreCase)
            ? "embedContent"
            : "generateContent";

        var client = _http.CreateClient();
        using var res = await client.SendAsync(Req(HttpMethod.Get, "/v1beta/models?pageSize=1000", rawKey), ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        var list = new List<AiModelInfo>();
        if (!doc.RootElement.TryGetProperty("models", out var models)) return list;

        foreach (var m in models.EnumerateArray())
        {
            if (m.TryGetProperty("supportedGenerationMethods", out var methods) &&
                !methods.EnumerateArray().Any(x => x.GetString() == wantMethod))
                continue;

            var name = m.GetProperty("name").GetString() ?? "";   // "models/gemini-1.5-flash"
            var id = name.StartsWith("models/", StringComparison.Ordinal) ? name["models/".Length..] : name;
            var display = m.TryGetProperty("displayName", out var d) ? (d.GetString() ?? id) : id;
            // Gemini's ListModels does not expose pricing.
            list.Add(new AiModelInfo(id, display, Name, false, null, null, "Pricing not exposed"));
        }
        return list.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async Task<AiCompletion> CompleteAsync(
        string rawKey, string model, IReadOnlyList<AiChatMessage> messages,
        IReadOnlyList<AiToolSchema> tools, AiGenerationOptions? options, CancellationToken ct)
    {
        var contents = new List<object>();
        var systemParts = new List<object>();

        foreach (var m in messages)
        {
            switch (m.Role)
            {
                case "system":
                    if (!string.IsNullOrEmpty(m.Content)) systemParts.Add(new { text = m.Content });
                    break;
                case "user":
                    contents.Add(new { role = "user", parts = new object[] { new { text = m.Content ?? "" } } });
                    break;
                case "assistant":
                    if (m.ToolCalls is { Count: > 0 })
                    {
                        var parts = m.ToolCalls.Select(tc => (object)new
                        {
                            functionCall = new { name = tc.Name, args = ParseArgsObject(tc.ArgumentsJson) },
                        }).ToList();
                        if (!string.IsNullOrEmpty(m.Content)) parts.Insert(0, new { text = m.Content });
                        contents.Add(new { role = "model", parts });
                    }
                    else
                    {
                        contents.Add(new { role = "model", parts = new object[] { new { text = m.Content ?? "" } } });
                    }
                    break;
                case "tool":
                    contents.Add(new
                    {
                        role = "user",
                        parts = new object[]
                        {
                            new { functionResponse = new { name = m.Name ?? "", response = new { result = m.Content ?? "" } } },
                        },
                    });
                    break;
            }
        }

        var payload = new Dictionary<string, object?> { ["contents"] = contents };
        if (systemParts.Count > 0) payload["system_instruction"] = new { parts = systemParts };
        if (tools.Count > 0)
        {
            payload["tools"] = new object[]
            {
                new { function_declarations = tools.Select(ToWireTool).ToList() },
            };
            payload["tool_config"] = new { function_calling_config = new { mode = "AUTO" } };
        }

        var thinking = ThinkingConfig(model, options?.ReasoningEffort);
        if (thinking is not null) payload["generationConfig"] = new { thinkingConfig = thinking };

        var client = _http.CreateClient();
        var req = Req(HttpMethod.Post, $"/v1beta/models/{model}:generateContent", rawKey);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (!root.TryGetProperty("candidates", out var candidates) || candidates.GetArrayLength() == 0)
            return new AiCompletion("", new List<AiToolCall>());

        var textSb = new StringBuilder();
        var calls = new List<AiToolCall>();
        var content = candidates[0].GetProperty("content");
        if (content.TryGetProperty("parts", out var contentParts))
        {
            foreach (var part in contentParts.EnumerateArray())
            {
                if (part.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
                    textSb.Append(t.GetString());
                else if (part.TryGetProperty("functionCall", out var fc))
                {
                    var fname = fc.GetProperty("name").GetString() ?? "";
                    var args = fc.TryGetProperty("args", out var a) ? a.GetRawText() : "{}";
                    calls.Add(new AiToolCall("call_" + Guid.NewGuid().ToString("N"), fname, args));
                }
            }
        }
        return new AiCompletion(textSb.Length > 0 ? textSb.ToString() : null, calls);
    }

    // --- helpers ---

    /// <summary>Translate the shared reasoning-effort value into Gemini's thinkingConfig, picking the right
    /// knob per model family: 3.x → thinkingLevel (LOW/MEDIUM/HIGH); 2.5 → thinkingBudget (token count).
    /// Returns null (→ no generationConfig) for "auto"/empty or models without thinking support (1.5/2.0).</summary>
    private static object? ThinkingConfig(string model, string? effort)
    {
        if (string.IsNullOrWhiteSpace(effort) ||
            string.Equals(effort, "auto", StringComparison.OrdinalIgnoreCase))
            return null;

        var m = model.ToLowerInvariant();

        if (m.Contains("gemini-3"))
        {
            // Gemini 3.x can't fully disable thinking, so "off" clamps to the lowest level.
            var level = effort.ToLowerInvariant() switch
            {
                "off" or "low" => "LOW",
                "medium" => "MEDIUM",
                "high" => "HIGH",
                _ => null,
            };
            return level is null ? null : new { thinkingLevel = level };
        }

        if (m.Contains("2.5"))
        {
            // 2.5 Pro can't take budget 0 (it has a non-zero minimum); "off" on a Pro model uses that floor.
            var isPro = m.Contains("pro");
            var budget = effort.ToLowerInvariant() switch
            {
                "off" => isPro ? 128 : 0,
                "low" => 2048,
                "medium" => 8192,
                "high" => 24576,
                _ => -1,   // unknown → dynamic
            };
            return new { thinkingBudget = budget };
        }

        return null;   // 1.5 / 2.0 and anything else: no thinking support → send nothing.
    }

    private static object ToWireTool(AiToolSchema t)
    {
        using var doc = JsonDocument.Parse(t.ParametersJson);
        return new { name = t.Name, description = t.Description, parameters = doc.RootElement.Clone() };
    }

    private static JsonElement ParseArgsObject(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            return doc.RootElement.Clone();
        }
        catch
        {
            using var doc = JsonDocument.Parse("{}");
            return doc.RootElement.Clone();
        }
    }

    // Full error so it can be copied from the chat: parsed message/status plus the raw response body.
    private static string ExtractError(string body, HttpStatusCode status)
    {
        var head = $"HTTP {(int)status} {status}";
        string? summary = null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.Object)
            {
                var sb = new StringBuilder();
                if (err.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.String) sb.Append(msg.GetString());
                if (err.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String) sb.Append($" [status: {st.GetString()}]");
                summary = sb.Length > 0 ? sb.ToString() : err.GetRawText();
            }
        }
        catch { /* not JSON */ }
        var raw = string.IsNullOrWhiteSpace(body) ? "(empty response body)" : (body.Trim().Length > 4000 ? body.Trim()[..4000] + "…(truncated)" : body.Trim());
        return summary is null ? $"{head}. Raw response: {raw}" : $"{head}: {summary}\nRaw response: {raw}";
    }

    private static AiProviderException MapError(HttpStatusCode status, string body)
    {
        var message = ExtractError(body, status);
        var lower = body.ToLowerInvariant();
        AiErrorKind kind;
        if (lower.Contains("api_key_invalid") || lower.Contains("api key not valid") || (int)status == 403)
            kind = AiErrorKind.Auth;
        else if ((int)status == 429 || lower.Contains("resource_exhausted"))
            kind = AiErrorKind.Quota;
        else if ((int)status >= 500)
            kind = AiErrorKind.Transient;
        else
            kind = AiErrorKind.Other;
        return new AiProviderException(kind, message);
    }
}
