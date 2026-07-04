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

    // --- End-user webapp/app proxy primitives. The client sends provider-native request bodies so the
    // mobile app can mirror the browser's @google/genai calls; the key is injected here and never leaves
    // the server. All of these run under KeyFailoverRunner, so they throw typed AiProviderException. ---

    public async Task<float[]> EmbedAsync(string rawKey, string model, string text, int dimensions, CancellationToken ct)
    {
        var payload = new Dictionary<string, object?>
        {
            ["content"] = new { parts = new[] { new { text } } },
        };
        if (dimensions is 768 or 1536 or 3072) payload["outputDimensionality"] = dimensions;

        var client = _http.CreateClient();
        var req = Req(HttpMethod.Post, $"/v1beta/models/{model}:embedContent", rawKey);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("embedding", out var emb) || !emb.TryGetProperty("values", out var values))
            throw new AiProviderException(AiErrorKind.Transient, "Gemini returned no embedding.");

        var vec = values.EnumerateArray().Select(v => (float)v.GetDouble()).ToArray();
        // L2-normalize so app-embedded vectors share the browser-embedded vectors' space (cosine is
        // scale-invariant, but keeping magnitudes uniform avoids surprises when the two clients mix).
        double norm = Math.Sqrt(vec.Sum(x => (double)x * x));
        if (norm > 1e-9) for (var i = 0; i < vec.Length; i++) vec[i] = (float)(vec[i] / norm);
        return vec;
    }

    public async Task<string> GenerateTextAsync(string rawKey, string model, string requestBodyJson, CancellationToken ct)
    {
        var client = _http.CreateClient();
        var req = Req(HttpMethod.Post, $"/v1beta/models/{model}:generateContent", rawKey);
        req.Content = new StringContent(requestBodyJson, Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        var sb = new StringBuilder();
        if (doc.RootElement.TryGetProperty("candidates", out var cands) && cands.GetArrayLength() > 0
            && cands[0].TryGetProperty("content", out var content)
            && content.TryGetProperty("parts", out var parts))
        {
            foreach (var p in parts.EnumerateArray())
                if (p.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String) sb.Append(t.GetString());
        }
        return sb.ToString();
    }

    public async Task StreamGenerateAsync(string rawKey, string model, string requestBodyJson,
        Func<ReadOnlyMemory<byte>, CancellationToken, Task> onSse, CancellationToken ct)
    {
        var client = _http.CreateClient();
        client.Timeout = Timeout.InfiniteTimeSpan; // the stream itself governs duration
        var req = Req(HttpMethod.Post, $"/v1beta/models/{model}:streamGenerateContent?alt=sse", rawKey);
        req.Content = new StringContent(requestBodyJson, Encoding.UTF8, "application/json");

        // ResponseHeadersRead: inspect the status BEFORE relaying, so a bad-key/quota error still fails
        // over to the next key without a single byte reaching the client.
        var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        try
        {
            if (!res.IsSuccessStatusCode)
            {
                var body = await res.Content.ReadAsStringAsync(ct);
                throw MapError(res.StatusCode, body);
            }
            await using var stream = await res.Content.ReadAsStreamAsync(ct);
            var buffer = new byte[8192];
            int read;
            while ((read = await stream.ReadAsync(buffer, ct)) > 0)
                await onSse(buffer.AsMemory(0, read), ct);
        }
        finally
        {
            res.Dispose();
        }
    }

    public async Task<IReadOnlyList<WebappModelInfo>> ListModelDetailsAsync(string rawKey, CancellationToken ct)
    {
        var client = _http.CreateClient();
        using var res = await client.SendAsync(Req(HttpMethod.Get, "/v1beta/models?pageSize=1000", rawKey), ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        var list = new List<WebappModelInfo>();
        if (!doc.RootElement.TryGetProperty("models", out var models)) return list;
        foreach (var m in models.EnumerateArray())
        {
            var name = m.GetProperty("name").GetString() ?? "";
            var id = name.StartsWith("models/", StringComparison.Ordinal) ? name["models/".Length..] : name;
            var display = m.TryGetProperty("displayName", out var d) ? (d.GetString() ?? id) : id;
            var methods = m.TryGetProperty("supportedGenerationMethods", out var mm) && mm.ValueKind == JsonValueKind.Array
                ? mm.EnumerateArray().Select(x => x.GetString() ?? "").Where(s => s.Length > 0).ToArray()
                : Array.Empty<string>();
            list.Add(new WebappModelInfo(id, display, methods));
        }
        return list;
    }

    public async Task<(byte[] Pcm, string Mime)> SynthesizeSpeechAsync(
        string rawKey, string model, string text, string voiceName, CancellationToken ct)
    {
        // generateContent is the proven path (the web client uses it and works). Only some models
        // (e.g. Gemini 3.x TTS) reject it — those return a non-retryable "Other" error, in which case
        // fall back to the Interactions API. Auth/Quota/Transient still bubble to the key-failover.
        try
        {
            return await SynthViaGenerateContentAsync(rawKey, model, text, voiceName, ct);
        }
        catch (AiProviderException ex) when (ex.Kind == AiErrorKind.Other)
        {
            return await SynthViaInteractionsAsync(rawKey, model, text, voiceName, ct);
        }
    }

    // Gemini 2.x TTS: v1beta generateContent with AUDIO modality (camelCase config).
    private async Task<(byte[] Pcm, string Mime)> SynthViaGenerateContentAsync(
        string rawKey, string model, string text, string voiceName, CancellationToken ct)
    {
        var payload = new Dictionary<string, object?>
        {
            ["contents"] = new[] { new { role = "user", parts = new[] { new { text } } } },
            ["generationConfig"] = new
            {
                responseModalities = new[] { "AUDIO" },
                speechConfig = new { voiceConfig = new { prebuiltVoiceConfig = new { voiceName } } },
            },
        };

        var client = _http.CreateClient();
        var req = Req(HttpMethod.Post, $"/v1beta/models/{model}:generateContent", rawKey);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body); // Auth/Quota/Transient → failover advances

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.TryGetProperty("candidates", out var candidates) && candidates.GetArrayLength() > 0
            && candidates[0].TryGetProperty("content", out var content)
            && content.TryGetProperty("parts", out var parts))
        {
            foreach (var part in parts.EnumerateArray())
            {
                if (part.TryGetProperty("inlineData", out var inline)
                    && inline.TryGetProperty("data", out var dataEl)
                    && dataEl.ValueKind == JsonValueKind.String)
                {
                    var b64 = dataEl.GetString()!;
                    var mime = inline.TryGetProperty("mimeType", out var m) ? m.GetString() : null;
                    return (Convert.FromBase64String(b64), mime ?? "audio/L16;codec=pcm;rate=24000");
                }
            }
        }

        // Malformed / no audio: throw Transient (not a silent return) so failover tries the next key.
        throw new AiProviderException(AiErrorKind.Transient, "Gemini returned no audio for the TTS request.");
    }

    // Gemini 3.x TTS: v1beta Interactions API (snake_case body, different response envelope).
    private async Task<(byte[] Pcm, string Mime)> SynthViaInteractionsAsync(
        string rawKey, string model, string text, string voiceName, CancellationToken ct)
    {
        var payload = new Dictionary<string, object?>
        {
            ["model"] = model,
            ["input"] = text,
            ["response_format"] = new { type = "audio" },
            ["generation_config"] = new { speech_config = new[] { new { voice = voiceName } } },
        };

        var client = _http.CreateClient();
        var req = Req(HttpMethod.Post, "/v1beta/interactions", rawKey);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        if (TryFindAudioData(doc.RootElement, out var b64, out var mime))
            return (Convert.FromBase64String(b64), mime ?? "audio/L16;codec=pcm;rate=24000");

        throw new AiProviderException(AiErrorKind.Transient, "Gemini returned no audio for the TTS request.");
    }

    /// <summary>Tolerantly locate base64 audio in a response of uncertain shape (the Interactions API
    /// response envelope isn't fully documented): the first object with a long "data" string, capturing
    /// any sibling "*mime*" field. Handles output_audio.data and arbitrary nesting.</summary>
    private static bool TryFindAudioData(JsonElement el, out string data, out string? mime)
    {
        data = "";
        mime = null;
        if (el.ValueKind == JsonValueKind.Object)
        {
            string? found = null;
            string? m = null;
            foreach (var prop in el.EnumerateObject())
            {
                if (prop.NameEquals("data") && prop.Value.ValueKind == JsonValueKind.String)
                {
                    var s = prop.Value.GetString();
                    if (!string.IsNullOrEmpty(s) && s.Length > 32) found = s;
                }
                else if (prop.Name.Contains("mime", StringComparison.OrdinalIgnoreCase)
                         && prop.Value.ValueKind == JsonValueKind.String)
                    m = prop.Value.GetString();
            }
            if (found is not null)
            {
                data = found;
                mime = m;
                return true;
            }
            foreach (var prop in el.EnumerateObject())
                if (TryFindAudioData(prop.Value, out data, out mime)) return true;
        }
        else if (el.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in el.EnumerateArray())
                if (TryFindAudioData(item, out data, out mime)) return true;
        }
        return false;
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
