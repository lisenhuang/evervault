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

    /// <summary>Google's documented dummy thoughtSignature: Gemini 3.x strictly validates that replayed
    /// functionCall parts carry their signature, and this sentinel tells it to skip that check — the
    /// escape hatch for history whose tool calls came from another provider (docs: "Thought signatures",
    /// ai.google.dev/gemini-api/docs/gemini-3). Models that don't validate ignore the field.</summary>
    private const string SkipThoughtSignatureValidation = "context_engineering_is_the_way_to_go";

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
                        // Gemini 3.x demands the part-level thoughtSignature captured at parse time be
                        // echoed verbatim next to the replayed functionCall, or the request 400s. Calls
                        // that never had one (another provider produced them — e.g. a ChatGPT primary
                        // whose turn falls back to Gemini mid tool-loop) get Google's documented dummy
                        // value that skips the validation instead of failing the whole turn.
                        var parts = m.ToolCalls.Select(tc => (object)new
                        {
                            functionCall = new { name = tc.Name, args = ParseArgsObject(tc.ArgumentsJson) },
                            thoughtSignature = string.IsNullOrEmpty(tc.ThoughtSignature)
                                ? SkipThoughtSignatureValidation
                                : tc.ThoughtSignature,
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
        // Long thinking generations can exceed the factory default (100s); match ProxyRestAsync and
        // the OpenAI client so a slow-but-fine completion isn't killed and misread as a cancellation.
        client.Timeout = TimeSpan.FromMinutes(10);
        var req = Req(HttpMethod.Post, $"/v1beta/models/{model}:generateContent", rawKey);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var usage = ParseUsage(root);
        if (!root.TryGetProperty("candidates", out var candidates) || candidates.GetArrayLength() == 0)
            return new AiCompletion("", new List<AiToolCall>(), Usage: usage);

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
                    // Part-level signature (sibling of functionCall) — Gemini 3.x requires it echoed on replay.
                    var sig = part.TryGetProperty("thoughtSignature", out var ts) && ts.ValueKind == JsonValueKind.String
                        ? ts.GetString() : null;
                    calls.Add(new AiToolCall("call_" + Guid.NewGuid().ToString("N"), fname, args, sig));
                }
            }
        }
        return new AiCompletion(textSb.Length > 0 ? textSb.ToString() : null, calls, Usage: usage);
    }

    /// <summary>
    /// Run one search-grounded generation: hand the query to the model with Google's built-in
    /// <c>google_search</c> tool so it searches the live web and answers from what it finds. Used as the
    /// web-search fallback when the primary search provider is rate-limited or down.
    ///
    /// The built-in tool is sent ALONE — Gemini 2.x rejects a request that mixes <c>google_search</c> with
    /// <c>function_declarations</c> ("Usage of built-in Google tools are not supported with external tools"),
    /// so this is deliberately a standalone call rather than something folded into the normal tool loop.
    /// Thinking is left at the model default: the search itself is the expensive part and a grounded lookup
    /// gains nothing from a bigger reasoning budget.
    ///
    /// The returned source URIs are Google redirect links, not real pages — the caller MUST resolve them
    /// (see <c>GeminiWebSearchService</c>) before they reach a user.
    /// </summary>
    public async Task<GroundedSearch> SearchWebAsync(
        string rawKey, string model, string query, CancellationToken ct)
    {
        var payload = new Dictionary<string, object?>
        {
            ["contents"] = new[] { new { role = "user", parts = new[] { new { text = query } } } },
            ["tools"] = new object[] { new { google_search = new { } } },
        };

        var client = _http.CreateClient();
        var req = Req(HttpMethod.Post, $"/v1beta/models/{model}:generateContent", rawKey);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        // A key with no grounding entitlement answers 429 RESOURCE_EXHAUSTED with a zero quota, which maps to
        // Quota → KeyFailoverRunner rolls to the next key. Malformed-request 400s map to Other and surface
        // immediately, so a coding mistake can never burn the whole key pool one 400 at a time.
        if (!res.IsSuccessStatusCode) throw MapError(res.StatusCode, body);

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var usage = ParseUsage(root);
        if (!root.TryGetProperty("candidates", out var candidates) || candidates.GetArrayLength() == 0)
            return new GroundedSearch(null, Array.Empty<GroundedSearchSource>(), usage);

        var candidate = candidates[0];

        var answer = new StringBuilder();
        if (candidate.TryGetProperty("content", out var content)
            && content.TryGetProperty("parts", out var parts))
        {
            foreach (var part in parts.EnumerateArray())
                if (part.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
                    answer.Append(t.GetString());
        }

        return new GroundedSearch(
            answer.Length > 0 ? answer.ToString() : null,
            ParseGroundingSources(candidate),
            usage);
    }

    /// <summary>
    /// Pull the cited web sources out of <c>groundingMetadata</c>. Each <c>groundingChunk</c> carries a
    /// <c>web.uri</c> (a redirect) and <c>web.title</c> (usually just the domain); the per-claim snippet comes
    /// from <c>groundingSupports</c>, which maps a span of the answer to the chunks backing it.
    ///
    /// Snippets are taken from <c>segment.text</c> verbatim rather than sliced out of the answer with
    /// <c>startIndex</c>/<c>endIndex</c>. Those offsets are UTF-8 BYTE offsets, not character indices, so
    /// slicing a C# string with them silently corrupts any non-ASCII answer — which for this app's CJK users
    /// would be every answer. Google supplies the resolved text anyway, so the offsets are never needed.
    /// </summary>
    private static IReadOnlyList<GroundedSearchSource> ParseGroundingSources(JsonElement candidate)
    {
        if (!candidate.TryGetProperty("groundingMetadata", out var meta)
            || meta.ValueKind != JsonValueKind.Object
            || !meta.TryGetProperty("groundingChunks", out var chunks)
            || chunks.ValueKind != JsonValueKind.Array)
            return Array.Empty<GroundedSearchSource>();

        // chunk index → the first answer span that cited it, used as that source's snippet.
        var snippets = new Dictionary<int, string>();
        if (meta.TryGetProperty("groundingSupports", out var supports)
            && supports.ValueKind == JsonValueKind.Array)
        {
            foreach (var s in supports.EnumerateArray())
            {
                if (!s.TryGetProperty("segment", out var seg)
                    || !seg.TryGetProperty("text", out var segText)
                    || segText.ValueKind != JsonValueKind.String) continue;
                var text = segText.GetString() ?? "";
                if (text.Length == 0) continue;

                if (!s.TryGetProperty("groundingChunkIndices", out var idxs)
                    || idxs.ValueKind != JsonValueKind.Array) continue;
                foreach (var i in idxs.EnumerateArray())
                    if (i.ValueKind == JsonValueKind.Number && i.TryGetInt32(out var idx))
                        snippets.TryAdd(idx, text);
            }
        }

        var sources = new List<GroundedSearchSource>();
        var n = 0;
        foreach (var chunk in chunks.EnumerateArray())
        {
            var index = n++;
            // groundingChunk is a oneof (web | retrievedContext | maps); google_search always yields web,
            // but a chunk without it is skipped rather than trusted.
            if (!chunk.TryGetProperty("web", out var web) || web.ValueKind != JsonValueKind.Object) continue;
            var uri = Str(web, "uri");
            if (uri.Length == 0) continue;
            sources.Add(new GroundedSearchSource(
                Str(web, "title"),
                uri,
                snippets.TryGetValue(index, out var snip) ? snip : ""));
        }
        return sources;
    }

    private static string Str(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    /// <summary>Lift token counts out of Gemini's <c>usageMetadata</c> (promptTokenCount /
    /// candidatesTokenCount / totalTokenCount). Best-effort — returns null if absent.</summary>
    private static AiUsage? ParseUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usageMetadata", out var u) || u.ValueKind != JsonValueKind.Object) return null;
        int? Get(string name) => u.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            && v.TryGetInt32(out var n) ? n : null;
        var prompt = Get("promptTokenCount");
        var completion = Get("candidatesTokenCount");
        var total = Get("totalTokenCount");
        return prompt is null && completion is null && total is null ? null : new AiUsage(prompt, completion, total);
    }

    public async Task<(byte[] Pcm, string Mime)> SynthesizeSpeechAsync(
        string rawKey, string model, string text, string voiceName, CancellationToken ct)
    {
        // Gemini TTS occasionally emits *text* tokens instead of audio — a known classifier flake that
        // surfaces either as an outright "Model tried to generate text… should only be used for TTS"
        // rejection or as a 200 with no audio part. Google's TTS docs recommend automated retry for
        // exactly this, so make a few attempts before giving up. A genuine Auth/Quota error is not
        // matched here, so it still bubbles up to KeyFailoverRunner to advance to the next key.
        const int maxAttempts = 3;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await SynthOnceAsync(rawKey, model, text, voiceName, ct);
            }
            catch (AiProviderException ex) when (IsTextInsteadOfAudio(ex) && attempt < maxAttempts)
            {
                // The model returned text, not audio — retry the same key.
            }
        }
    }

    // One synthesis attempt: generateContent is the path the web client uses; some models/keys reject
    // it (e.g. Gemini 3.x TTS previews return a non-retryable "Other"), in which case fall back to the
    // Interactions API. Auth/Quota/Transient still bubble to the key-failover.
    private async Task<(byte[] Pcm, string Mime)> SynthOnceAsync(
        string rawKey, string model, string text, string voiceName, CancellationToken ct)
    {
        try
        {
            return await SynthViaGenerateContentAsync(rawKey, model, text, voiceName, ct);
        }
        catch (AiProviderException ex) when (ex.Kind == AiErrorKind.Other)
        {
            return await SynthViaInteractionsAsync(rawKey, model, text, voiceName, ct);
        }
    }

    // The model produced text instead of audio — a retryable flake per Google's TTS guidance. Covers
    // both the explicit "tried to generate text / should only be used for TTS" rejection and the
    // "no audio in a 200 response" case (thrown as Transient by the synth methods below).
    private static bool IsTextInsteadOfAudio(AiProviderException ex) =>
        ex.Kind == AiErrorKind.Transient
        || ex.Message.Contains("generate text", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("only be used for TTS", StringComparison.OrdinalIgnoreCase);

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
        // 401 is included deliberately: Google's newer service-account-bound "auth keys" (the AQ.* format
        // AI Studio now issues) can come back 401 UNAUTHENTICATED / ACCESS_TOKEN_TYPE_UNSUPPORTED on the
        // native endpoint for some accounts. Without this, a 401 fell through to Other and aborted the whole
        // request on the first bad key instead of failing over to the next one.
        if (lower.Contains("api_key_invalid") || lower.Contains("api key not valid")
            || (int)status == 401 || (int)status == 403)
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
