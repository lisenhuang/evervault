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
        // "embedding" → embedContent; "live" → bidiGenerateContent (realtime); otherwise chat (generateContent).
        var wantMethod = kind?.ToLowerInvariant() switch
        {
            "embedding" => "embedContent",
            "live" => "bidiGenerateContent",
            _ => "generateContent",
        };

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

    /// <summary>
    /// Forward a raw REST call to the Gemini API with the given key, for the keyless /webapp reverse-proxy.
    /// The response is returned with only headers read (body NOT buffered), so a streaming
    /// <c>:streamGenerateContent</c> passes straight through; the caller owns disposal and streams
    /// <see cref="HttpResponseMessage.Content"/> to the browser. On a non-success status the upstream
    /// error is mapped and thrown so <see cref="KeyFailoverRunner"/> advances to the next key (before the
    /// caller has written any bytes to the client). The raw key travels only in the <c>x-goog-api-key</c>
    /// header — never the URL — so it can't leak into access logs.
    /// </summary>
    public async Task<HttpResponseMessage> ProxyRestAsync(
        string rawKey, HttpMethod method, string pathAndQuery, byte[]? body, string? contentType, CancellationToken ct)
    {
        var client = _http.CreateClient();
        // A streamed generation can hold the connection well past the default 100s; the browser's
        // RequestAborted cancels early, so a generous ceiling just prevents a spurious timeout mid-stream.
        client.Timeout = TimeSpan.FromMinutes(10);

        var req = Req(method, pathAndQuery, rawKey);
        if (body is { Length: > 0 })
        {
            var content = new ByteArrayContent(body);
            if (!string.IsNullOrWhiteSpace(contentType))
                content.Headers.TryAddWithoutValidation("Content-Type", contentType);
            req.Content = content;
        }

        var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!res.IsSuccessStatusCode)
        {
            var status = res.StatusCode;
            var errBody = await res.Content.ReadAsStringAsync(ct);
            res.Dispose();
            throw MapError(status, errBody);   // Auth/Quota/Transient → failover advances to the next key
        }
        return res;
    }

    /// <summary>
    /// Mint a short-lived, single-use ephemeral auth token for the Live API (<c>POST /v1alpha/auth_tokens</c>),
    /// so the browser can open the realtime audio socket <b>directly to Google</b> without ever seeing a real
    /// key. Wrapped by <see cref="KeyFailoverRunner"/>, so a mint that hits an exhausted/invalid key rolls to
    /// the next. Returns the token resource name (used as the client's apiKey) and its expiry.
    /// <paramref name="model"/> is the admin-configured live model; it is not locked into the token today, so
    /// the client still supplies voice/persona/tools/resumption at connect (the webapp only ever connects with
    /// this model) — locking via <c>bidiGenerateContentSetup</c> can be added later.
    /// </summary>
    public async Task<(string Token, string? ExpiresAt)> CreateLiveEphemeralTokenAsync(
        string rawKey, string model, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        static string Rfc3339(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ");
        var payload = new Dictionary<string, object?>
        {
            ["uses"] = 1,                                        // one Live session per token
            ["expireTime"] = Rfc3339(now.AddMinutes(30)),       // token stops working after this
            ["newSessionExpireTime"] = Rfc3339(now.AddMinutes(2)), // must start the session within 2 min
        };

        var client = _http.CreateClient();
        var req = Req(HttpMethod.Post, "/v1alpha/auth_tokens", rawKey);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var respBody = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, respBody);

        using var doc = JsonDocument.Parse(respBody);
        var name = doc.RootElement.TryGetProperty("name", out var n) ? n.GetString() : null;
        if (string.IsNullOrEmpty(name))
            throw new AiProviderException(AiErrorKind.Transient, "Gemini returned no ephemeral token.");
        var expires = doc.RootElement.TryGetProperty("expireTime", out var e) ? e.GetString() : null;
        return (name!, expires);
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
        var (status, body) = await SendTtsAsync(client, req, ct);
        if (!IsSuccess(status)) throw MapError(status, body); // Auth/Quota/Transient → failover advances

        using var doc = ParseTts(body);
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
        var (status, body) = await SendTtsAsync(client, req, ct);
        if (!IsSuccess(status)) throw MapError(status, body);

        using var doc = ParseTts(body);
        if (TryFindAudioData(doc.RootElement, out var b64, out var mime))
            return (Convert.FromBase64String(b64), mime ?? "audio/L16;codec=pcm;rate=24000");

        throw new AiProviderException(AiErrorKind.Transient, "Gemini returned no audio for the TTS request.");
    }

    // Send a TTS request and read its (buffered) body, translating transport-level failures — a network
    // blip or the HttpClient timeout — into a Transient AiProviderException. Without this, such an error
    // is a raw HttpRequestException/TaskCanceledException that KeyFailoverRunner does NOT catch (its filter
    // matches only AiProviderException), so it bubbles out as an unhandled 500 with no JSON body — which
    // the webapp preview can only render as the generic "Could not load the voice sample." fallback.
    // As a Transient error it instead advances failover to the next key, and if all keys fail the caller
    // returns a real {error} message.
    private static async Task<(HttpStatusCode Status, string Body)> SendTtsAsync(
        HttpClient client, HttpRequestMessage req, CancellationToken ct)
    {
        try
        {
            using var res = await client.SendAsync(req, ct);
            var body = await res.Content.ReadAsStringAsync(ct);
            return (res.StatusCode, body);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw; // the caller/client cancelled — not a key failure, let it propagate
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException)
        {
            // OperationCanceledException with ct NOT cancelled == the HttpClient timeout elapsed.
            throw new AiProviderException(AiErrorKind.Transient, $"Gemini TTS request failed: {ex.Message}");
        }
    }

    // Parse a TTS response body, mapping a malformed (non-JSON) 200 to a Transient error so failover retries
    // rather than throwing a raw JsonException that would escape as an unhandled 500.
    private static JsonDocument ParseTts(string body)
    {
        try { return JsonDocument.Parse(body); }
        catch (JsonException ex)
        {
            throw new AiProviderException(AiErrorKind.Transient, $"Gemini returned an unreadable TTS response: {ex.Message}");
        }
    }

    private static bool IsSuccess(HttpStatusCode status) => (int)status is >= 200 and < 300;

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
