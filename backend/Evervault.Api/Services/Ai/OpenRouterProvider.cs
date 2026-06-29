using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Evervault.Api.Services.Ai;

/// <summary>OpenRouter (OpenAI-compatible) provider. Lists models with per-token pricing, validates
/// keys via /key, and runs chat completions with function calling.</summary>
public class OpenRouterProvider : IAiProvider
{
    private const string Base = "https://openrouter.ai/api/v1";
    private readonly IHttpClientFactory _http;

    public OpenRouterProvider(IHttpClientFactory http) => _http = http;

    public string Name => "openrouter";

    private HttpRequestMessage Req(HttpMethod method, string path, string key)
    {
        var r = new HttpRequestMessage(method, Base + path);
        r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        r.Headers.TryAddWithoutValidation("HTTP-Referer", "https://evervault.local");
        r.Headers.TryAddWithoutValidation("X-Title", "Evervault Admin");
        return r;
    }

    public async Task<(bool Ok, string Message)> ValidateKeyAsync(string rawKey, CancellationToken ct)
    {
        var client = _http.CreateClient();
        using var res = await client.SendAsync(Req(HttpMethod.Get, "/key", rawKey), ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (res.IsSuccessStatusCode) return (true, "Valid");
        return (false, ExtractError(body, res.StatusCode));
    }

    public async Task<IReadOnlyList<AiModelInfo>> ListModelsAsync(string rawKey, CancellationToken ct)
    {
        var client = _http.CreateClient();
        using var res = await client.SendAsync(Req(HttpMethod.Get, "/models", rawKey), ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        var list = new List<AiModelInfo>();
        if (!doc.RootElement.TryGetProperty("data", out var data)) return list;

        foreach (var m in data.EnumerateArray())
        {
            var id = m.GetProperty("id").GetString() ?? "";
            var name = m.TryGetProperty("name", out var n) ? (n.GetString() ?? id) : id;
            decimal? promptM = null, completionM = null;
            if (m.TryGetProperty("pricing", out var pricing))
            {
                promptM = PerMillion(pricing, "prompt");
                completionM = PerMillion(pricing, "completion");
            }
            var isFree = (promptM is null or 0m) && (completionM is null or 0m);
            list.Add(new AiModelInfo(id, name, Name, isFree, promptM, completionM,
                BuildPriceLabel(isFree, promptM, completionM)));
        }
        return list.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async Task<AiCompletion> CompleteAsync(
        string rawKey, string model, IReadOnlyList<AiChatMessage> messages,
        IReadOnlyList<AiToolSchema> tools, CancellationToken ct)
    {
        var payload = new Dictionary<string, object?>
        {
            ["model"] = model,
            ["messages"] = messages.Select(ToWireMessage).ToList(),
        };
        if (tools.Count > 0)
        {
            payload["tools"] = tools.Select(ToWireTool).ToList();
            payload["tool_choice"] = "auto";
        }

        var client = _http.CreateClient();
        var req = Req(HttpMethod.Post, "/chat/completions", rawKey);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        JsonDocument doc;
        try { doc = JsonDocument.Parse(body); }
        catch { throw new AiProviderException(AiErrorKind.Transient, ExtractError(body, res.StatusCode)); }
        using (doc)
        {
            var root = doc.RootElement;
            // OpenRouter can return HTTP 200 with an embedded error when the upstream provider fails.
            if (root.TryGetProperty("error", out _)) throw MapError(res.StatusCode, body);
            if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
                throw new AiProviderException(AiErrorKind.Transient, "OpenRouter returned no choices. " + ExtractError(body, res.StatusCode));

            var message = choices[0].GetProperty("message");
            string? text = message.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String
                ? c.GetString()
                : null;

            var calls = new List<AiToolCall>();
            if (message.TryGetProperty("tool_calls", out var tc) && tc.ValueKind == JsonValueKind.Array)
            {
                foreach (var call in tc.EnumerateArray())
                {
                    var id = call.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? Guid.NewGuid().ToString("N") : Guid.NewGuid().ToString("N");
                    var fn = call.GetProperty("function");
                    var fname = fn.GetProperty("name").GetString() ?? "";
                    var args = fn.TryGetProperty("arguments", out var a) ? a.GetString() ?? "{}" : "{}";
                    calls.Add(new AiToolCall(id, fname, string.IsNullOrWhiteSpace(args) ? "{}" : args));
                }
            }
            return new AiCompletion(text, calls);
        }
    }

    // --- wire mapping ---

    private static object ToWireMessage(AiChatMessage m)
    {
        if (m.Role == "tool")
            return new { role = "tool", tool_call_id = m.ToolCallId, content = m.Content ?? "" };

        if (m.Role == "assistant" && m.ToolCalls is { Count: > 0 })
            return new
            {
                role = "assistant",
                content = (object?)m.Content,
                tool_calls = m.ToolCalls.Select(t => new
                {
                    id = t.Id,
                    type = "function",
                    function = new { name = t.Name, arguments = t.ArgumentsJson },
                }).ToList(),
            };

        return new { role = m.Role, content = m.Content ?? "" };
    }

    private static object ToWireTool(AiToolSchema t)
    {
        using var doc = JsonDocument.Parse(t.ParametersJson);
        return new
        {
            type = "function",
            function = new { name = t.Name, description = t.Description, parameters = doc.RootElement.Clone() },
        };
    }

    private static decimal? PerMillion(JsonElement pricing, string field)
    {
        if (!pricing.TryGetProperty(field, out var v)) return null;
        var s = v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString();
        if (decimal.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var perToken))
            return perToken * 1_000_000m;
        return null;
    }

    private static string BuildPriceLabel(bool isFree, decimal? promptM, decimal? completionM)
    {
        if (isFree) return "Free";
        string Fmt(decimal? d) => d is null ? "?" : "$" + d.Value.ToString("0.####", CultureInfo.InvariantCulture);
        return $"{Fmt(promptM)} in / {Fmt(completionM)} out per 1M tokens";
    }

    // Surfaces the FULL error so it can be copied from the chat: parsed message/code/metadata
    // plus the raw response body (OpenRouter hides the upstream provider's real error in metadata).
    private static string ExtractError(string body, HttpStatusCode status)
    {
        var head = $"HTTP {(int)status} {status}";
        var summary = ParseErrorSummary(body);
        var raw = string.IsNullOrWhiteSpace(body) ? "(empty response body)" : Truncate(body.Trim(), 4000);
        return summary is null ? $"{head}. Raw response: {raw}" : $"{head}: {summary}\nRaw response: {raw}";
    }

    private static string? ParseErrorSummary(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("error", out var err)) return null;
            if (err.ValueKind == JsonValueKind.String) return err.GetString();
            if (err.ValueKind != JsonValueKind.Object) return err.GetRawText();

            var sb = new StringBuilder();
            if (err.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String) sb.Append(m.GetString());
            if (err.TryGetProperty("code", out var c)) sb.Append($" [code: {Scalar(c)}]");
            if (err.TryGetProperty("metadata", out var meta) && meta.ValueKind != JsonValueKind.Null)
                sb.Append($" metadata: {Truncate(meta.GetRawText(), 3000)}");
            return sb.Length > 0 ? sb.ToString() : err.GetRawText();
        }
        catch { return null; }
    }

    private static string Scalar(JsonElement e) => e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : e.GetRawText();
    private static string Truncate(string s, int n) => s.Length > n ? s[..n] + "…(truncated)" : s;

    private static AiProviderException MapError(HttpStatusCode status, string body)
    {
        var kind = (int)status switch
        {
            401 or 403 => AiErrorKind.Auth,
            402 or 429 => AiErrorKind.Quota,
            >= 500 => AiErrorKind.Transient,
            _ => AiErrorKind.Other,
        };
        return new AiProviderException(kind, ExtractError(body, status));
    }
}
