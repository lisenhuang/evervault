using System.Net;
using System.Text;
using System.Text.Json;
using Evervault.Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// "ChatGPT (OAuth)" provider. Unlike the key-based providers, the "key" here is a short-lived OAuth
/// access token (managed by <c>OpenAiOAuthService</c> and handed in by <see cref="KeyFailoverRunner"/>),
/// used as the bearer for OpenAI's Responses API on the ChatGPT backend
/// (<c>https://chatgpt.com/backend-api/codex/responses</c>). Translates the neutral message/tool shapes
/// to the Responses <c>input</c>/flat-tool format and aggregates the SSE stream into one completion.
/// Reasoning items are round-tripped (via <see cref="AiCompletion.ProviderState"/>) because <c>store:false</c>
/// requires them echoed before the function_call they precede.
/// </summary>
public class OpenAiProvider : IAiProvider
{
    private const string ResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";
    private const string ModelsUrl = "https://chatgpt.com/backend-api/codex/models";

    // The /models endpoint gates its catalog by ?client_version= (each model carries a minimal_client_version),
    // so an old version hides newer models (5.5, 5.6, …). We present the current Codex CLI version, fetched
    // live from the npm registry (cached) so new models appear without a code change; the constant is only a
    // last-resort fallback if npm is unreachable.
    private const string FallbackClientVersion = "0.144.1";
    private const string NpmLatestUrl = "https://registry.npmjs.org/@openai/codex/latest";
    private static readonly TimeSpan VersionTtl = TimeSpan.FromHours(6);

    private volatile CachedVersion? _clientVersion;
    private sealed record CachedVersion(string Version, DateTimeOffset FetchedAt);

    private static string UserAgentFor(string version) => $"codex_cli_rs/{version} (Evervault Admin)";

    // The named HttpClient (registered in Program.cs) with a long timeout — a reasoning turn can far
    // exceed the default 100s while we hold the SSE stream open.
    public const string HttpClientName = "openai-codex";

    private readonly IHttpClientFactory _http;
    private readonly IOpenAiAccountId _accountId;

    public OpenAiProvider(IHttpClientFactory http, IOpenAiAccountId accountId)
    {
        _http = http;
        _accountId = accountId;
    }

    public string Name => "openai";

    // Latest rate-limit snapshot captured from chat responses (x-codex-* headers + the codex.rate_limits
    // SSE event). One connected account, so a single volatile field is enough. Surfaced by GetUsageAsync.
    private volatile RateSnapshot? _lastUsage;

    private sealed record RateSnapshot(IReadOnlyList<AiRateWindow> Windows, DateTimeOffset At);

    // Fallback only — shown before connect or if the live catalog can't be fetched. The real list comes
    // from the account's /models endpoint (see ListModelsAsync).
    private static readonly AiModelInfo[] FallbackModels =
    {
        new("gpt-5-codex", "GPT-5 Codex", "openai", false, null, null, "Included in ChatGPT plan"),
        new("gpt-5", "GPT-5", "openai", false, null, null, "Included in ChatGPT plan"),
    };

    public Task<(bool Ok, string Message)> ValidateKeyAsync(string rawKey, CancellationToken ct)
        => Task.FromResult(string.IsNullOrWhiteSpace(rawKey) ? (false, "Not connected.") : (true, "Connected"));

    /// <summary>ChatGPT plan usage: the 5-hour and weekly (7-day) quota windows + reset times. Tries a
    /// fresh <c>/wham/usage</c> read; falls back to the snapshot captured from the last chat response.</summary>
    public async Task<AiKeyUsage> GetUsageAsync(string rawKey, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(rawKey))
            return new AiKeyUsage(false, "Connect a ChatGPT account to see plan usage.", null, null, null, null, null, null);

        // A snapshot captured during a recent chat turn is the most reliable source (the standalone usage
        // endpoint is undocumented), so prefer it when fresh — the bars then appear instantly after a message.
        var cached = _lastUsage;
        if (cached is { Windows.Count: > 0 } && DateTimeOffset.UtcNow - cached.At < TimeSpan.FromMinutes(2))
            return BuildUsage(cached.Windows, note: null);

        var fresh = await TryFetchUsageAsync(rawKey, ct);
        if (fresh is { Count: > 0 })
        {
            _lastUsage = new RateSnapshot(fresh, DateTimeOffset.UtcNow);
            return BuildUsage(fresh, note: null);
        }

        if (cached is { Windows.Count: > 0 })
            return BuildUsage(cached.Windows, note: $"as of your last message ({Ago(cached.At)})");

        return new AiKeyUsage(false,
            "No usage yet — send a message on ChatGPT and your 5-hour and weekly limits will show here.",
            null, null, null, null, null, null);
    }

    /// <summary>Best-effort GET of the (undocumented) ChatGPT usage endpoint. Returns null on any failure.</summary>
    private async Task<IReadOnlyList<AiRateWindow>?> TryFetchUsageAsync(string token, CancellationToken ct)
    {
        try
        {
            var accountId = await _accountId.GetAccountIdAsync(ct);
            var client = _http.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://chatgpt.com/backend-api/wham/usage");
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            if (!string.IsNullOrWhiteSpace(accountId)) req.Headers.TryAddWithoutValidation("chatgpt-account-id", accountId);
            req.Headers.TryAddWithoutValidation("Accept", "application/json");
            using var res = await client.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return null;
            var body = await res.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);
            var rl = doc.RootElement.TryGetProperty("rate_limits", out var a) ? a
                : doc.RootElement.TryGetProperty("rate_limit", out var b) ? b
                : doc.RootElement;
            var windows = new List<AiRateWindow>();
            var primary = FindWindow(rl, "primary", "primary_window", "five_hour_limit", "primary_limit");
            var secondary = FindWindow(rl, "secondary", "secondary_window", "weekly_limit", "secondary_limit");
            if (primary is { } p) windows.Add(WindowFromJson(p, "5-hour limit"));
            if (secondary is { } s) windows.Add(WindowFromJson(s, "Weekly limit"));
            return windows.Count > 0 ? windows : null;
        }
        catch { return null; }
    }

    /// <summary>The Codex CLI version to present to the backend. Fetched from the npm registry and cached
    /// for <see cref="VersionTtl"/>; falls back to the last-known value, then <see cref="FallbackClientVersion"/>
    /// if npm can't be reached — so the model catalog stays current without a redeploy.</summary>
    private async Task<string> GetClientVersionAsync(CancellationToken ct)
    {
        var cached = _clientVersion;
        if (cached is not null && DateTimeOffset.UtcNow - cached.FetchedAt < VersionTtl)
            return cached.Version;
        try
        {
            var client = _http.CreateClient(HttpClientName);
            using var res = await client.GetAsync(NpmLatestUrl, ct);
            if (res.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
                if (doc.RootElement.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(v.GetString()))
                {
                    var ver = v.GetString()!;
                    _clientVersion = new CachedVersion(ver, DateTimeOffset.UtcNow);
                    return ver;
                }
            }
        }
        catch { /* npm unreachable — use the last-known or fallback below */ }
        return cached?.Version ?? FallbackClientVersion;
    }

    /// <summary>The models actually available to the connected ChatGPT account, fetched live from the
    /// Codex <c>/models</c> catalog with the OAuth token (visibility=list, ordered by the backend's
    /// priority). Falls back to a small static list when disconnected or the catalog can't be read.</summary>
    public async Task<IReadOnlyList<AiModelInfo>> ListModelsAsync(string rawKey, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(rawKey)) return FallbackModels; // not connected → show the fallback
        try
        {
            var accountId = await _accountId.GetAccountIdAsync(ct);
            var clientVersion = await GetClientVersionAsync(ct);
            var client = _http.CreateClient(HttpClientName);
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{ModelsUrl}?client_version={clientVersion}");
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + rawKey);
            if (!string.IsNullOrWhiteSpace(accountId)) req.Headers.TryAddWithoutValidation("chatgpt-account-id", accountId);
            req.Headers.TryAddWithoutValidation("originator", "codex_cli_rs");
            req.Headers.TryAddWithoutValidation("User-Agent", UserAgentFor(clientVersion));
            req.Headers.TryAddWithoutValidation("Accept", "application/json");
            using var res = await client.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return FallbackModels;

            var body = await res.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("models", out var arr) || arr.ValueKind != JsonValueKind.Array)
                return FallbackModels;

            var list = new List<(int Priority, AiModelInfo Info)>();
            foreach (var m in arr.EnumerateArray())
            {
                var slug = m.TryGetProperty("slug", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
                if (string.IsNullOrWhiteSpace(slug)) continue;
                // Match Codex's picker: show only "list" models (drops internal entries like "Codex Auto
                // Review"); keep models with no visibility set (permissive about unknown labels).
                var vis = m.TryGetProperty("visibility", out var vv) && vv.ValueKind == JsonValueKind.String ? vv.GetString() : null;
                if (vis is not null && !vis.Equals("list", StringComparison.OrdinalIgnoreCase)) continue;
                var name = m.TryGetProperty("display_name", out var dn) && dn.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(dn.GetString()) ? dn.GetString()! : slug!;
                var priority = m.TryGetProperty("priority", out var p) && p.TryGetInt32(out var pr) ? pr : 0;
                var (levels, def) = ReasoningLevels(m);
                list.Add((priority, new AiModelInfo(slug!, name, Name, false, null, null, "Included in ChatGPT plan", levels, def)));
            }
            return list.Count > 0 ? list.OrderBy(x => x.Priority).Select(x => x.Info).ToList() : FallbackModels;
        }
        catch
        {
            return FallbackModels;
        }
    }

    public async Task<AiCompletion> CompleteAsync(
        string rawKey, string model, IReadOnlyList<AiChatMessage> messages,
        IReadOnlyList<AiToolSchema> tools, AiGenerationOptions? options, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(rawKey))
            throw new AiProviderException(AiErrorKind.Auth,
                "No ChatGPT account is connected. Connect one under AI keys → ChatGPT (Sign in with ChatGPT).");

        var accountId = await _accountId.GetAccountIdAsync(ct);

        var instructions = string.Join("\n\n",
            messages.Where(m => m.Role == "system" && !string.IsNullOrWhiteSpace(m.Content)).Select(m => m.Content));

        var payload = new Dictionary<string, object?>
        {
            ["model"] = model,
            ["instructions"] = instructions,
            ["input"] = BuildInput(messages),
            ["store"] = false,
            ["stream"] = true,
            ["parallel_tool_calls"] = false,
            // Ask for the reasoning items' encrypted payload so we can echo them next turn under store:false.
            ["include"] = new[] { "reasoning.encrypted_content" },
        };
        if (tools.Count > 0)
        {
            payload["tools"] = tools.Select(ToWireTool).ToList();
            payload["tool_choice"] = "auto";
        }
        var reasoning = Reasoning(options?.ReasoningEffort);
        if (reasoning is not null) payload["reasoning"] = reasoning;

        var client = _http.CreateClient(HttpClientName);
        using var req = new HttpRequestMessage(HttpMethod.Post, ResponsesUrl);
        req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + rawKey);
        if (!string.IsNullOrWhiteSpace(accountId)) req.Headers.TryAddWithoutValidation("chatgpt-account-id", accountId);
        req.Headers.TryAddWithoutValidation("OpenAI-Beta", "responses=experimental");
        req.Headers.TryAddWithoutValidation("originator", "codex_cli_rs");
        req.Headers.TryAddWithoutValidation("User-Agent", UserAgentFor(await GetClientVersionAsync(ct)));
        // Stable per-conversation session id (derived from the first user message) so the backend's
        // per-session reasoning/rate accounting isn't fragmented across the turns of one chat.
        req.Headers.TryAddWithoutValidation("session_id", StableSessionId(messages));
        req.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!res.IsSuccessStatusCode)
        {
            var errBody = await res.Content.ReadAsStringAsync(ct);
            throw MapError(res.StatusCode, errBody);
        }

        var headerWindows = WindowsFromHeaders(res);
        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        var (completion, sseWindows) = await ParseSseAsync(stream, ct);

        // Prefer the in-stream codex.rate_limits event; fall back to the response headers.
        var windows = sseWindows ?? headerWindows;
        if (windows is { Count: > 0 }) _lastUsage = new RateSnapshot(windows, DateTimeOffset.UtcNow);
        return completion;
    }

    // --- request translation ---

    /// <summary>Neutral messages → Responses <c>input[]</c>. System messages become top-level
    /// <c>instructions</c> (handled by the caller) and are skipped here.</summary>
    private static List<object> BuildInput(IReadOnlyList<AiChatMessage> messages)
    {
        var input = new List<object>();
        foreach (var m in messages)
        {
            switch (m.Role)
            {
                case "system":
                    break; // folded into instructions
                case "user":
                    input.Add(new
                    {
                        type = "message",
                        role = "user",
                        content = new[] { new { type = "input_text", text = m.Content ?? "" } },
                    });
                    break;
                case "assistant":
                    // Echo reasoning items FIRST so they precede the function_call they reason about.
                    foreach (var item in ReasoningItems(m.ProviderState)) input.Add(item);
                    if (!string.IsNullOrEmpty(m.Content))
                        input.Add(new
                        {
                            type = "message",
                            role = "assistant",
                            content = new[] { new { type = "output_text", text = m.Content } },
                        });
                    if (m.ToolCalls is { Count: > 0 })
                        foreach (var tc in m.ToolCalls)
                            input.Add(new
                            {
                                type = "function_call",
                                call_id = tc.Id,
                                name = tc.Name,
                                arguments = string.IsNullOrWhiteSpace(tc.ArgumentsJson) ? "{}" : tc.ArgumentsJson,
                            });
                    break;
                case "tool":
                    input.Add(new
                    {
                        type = "function_call_output",
                        call_id = m.ToolCallId ?? "",
                        output = m.Content ?? "",
                    });
                    break;
            }
        }
        return input;
    }

    /// <summary>Parse the opaque provider state back into raw reasoning item objects to re-inject.</summary>
    private static IEnumerable<object> ReasoningItems(string? providerState)
    {
        if (string.IsNullOrWhiteSpace(providerState)) yield break;
        JsonDocument doc;
        try { doc = JsonDocument.Parse(providerState); }
        catch { yield break; }
        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Array) yield break;
            foreach (var el in doc.RootElement.EnumerateArray())
                yield return el.Clone(); // JsonElement serializes back verbatim
        }
    }

    /// <summary>Flat Responses tool shape (NOT nested under "function" like chat/completions).</summary>
    private static object ToWireTool(AiToolSchema t)
    {
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(t.ParametersJson) ? "{}" : t.ParametersJson);
        return new
        {
            type = "function",
            name = t.Name,
            description = t.Description,
            parameters = doc.RootElement.Clone(),
            strict = false,
        };
    }

    // The reasoning-effort levels the Responses API accepts. Models advertise their own subset.
    private static readonly HashSet<string> KnownEfforts =
        new(StringComparer.OrdinalIgnoreCase) { "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra" };

    private static object? Reasoning(string? effort)
    {
        if (string.IsNullOrWhiteSpace(effort) || string.Equals(effort, "auto", StringComparison.OrdinalIgnoreCase))
            return null;                                   // let the model use its own default
        var e = effort.Trim().ToLowerInvariant();
        if (e == "off") return new { effort = "minimal" }; // shared "off" maps to the lightest real level
        return KnownEfforts.Contains(e) ? new { effort = e } : null;
    }

    /// <summary>Parse a model entry's <c>supported_reasoning_levels</c> (each {effort, description}) and
    /// <c>default_reasoning_level</c> into plain strings for the UI.</summary>
    private static (IReadOnlyList<string>? Levels, string? Default) ReasoningLevels(JsonElement model)
    {
        List<string>? levels = null;
        if (model.TryGetProperty("supported_reasoning_levels", out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var p in arr.EnumerateArray())
            {
                var eff = p.ValueKind == JsonValueKind.String ? p.GetString()
                    : p.TryGetProperty("effort", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString()
                    : null;
                if (!string.IsNullOrWhiteSpace(eff)) (levels ??= new()).Add(eff!);
            }
        }
        var def = model.TryGetProperty("default_reasoning_level", out var d) && d.ValueKind == JsonValueKind.String
            ? d.GetString() : null;
        return (levels, def);
    }

    // --- SSE response parsing ---

    /// <summary>Consume the SSE stream and aggregate into one <see cref="AiCompletion"/> (plus any
    /// rate-limit snapshot). Prefers the terminal <c>response.completed</c> frame; falls back to deltas.</summary>
    private static async Task<(AiCompletion Completion, IReadOnlyList<AiRateWindow>? Windows)> ParseSseAsync(
        Stream stream, CancellationToken ct)
    {
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var deltaText = new StringBuilder();
        var doneItems = new List<JsonElement>();
        var doneReasoning = new List<JsonElement>();   // streamed reasoning items — carry encrypted_content
        JsonElement? completed = null;
        string? failure = null;
        var failureKind = AiErrorKind.Transient;
        IReadOnlyList<AiRateWindow>? rateWindows = null;

        // Proper SSE framing: an event is a run of event:/data: lines ended by a blank line; multiple
        // data: lines join with '\n' before parsing (a large frame can be split across data: lines).
        string? eventName = null;
        var dataBuf = new StringBuilder();

        void Flush()
        {
            var name = eventName;
            eventName = null;
            if (dataBuf.Length == 0) return;
            var data = dataBuf.ToString();
            dataBuf.Clear();
            if (data == "[DONE]") return;

            JsonElement root;
            try { using var d = JsonDocument.Parse(data); root = d.RootElement.Clone(); }
            catch { return; }

            // Dispatch on the in-data "type"; fall back to the SSE event: name if absent.
            var type = (root.TryGetProperty("type", out var t) ? t.GetString() : null) ?? name;
            switch (type)
            {
                case "response.output_text.delta":
                    if (root.TryGetProperty("delta", out var del) && del.ValueKind == JsonValueKind.String)
                        deltaText.Append(del.GetString());
                    break;
                case "response.output_item.done":
                    if (root.TryGetProperty("item", out var item))
                    {
                        var clone = item.Clone();
                        doneItems.Add(clone);
                        if (item.TryGetProperty("type", out var itT) && itT.GetString() == "reasoning")
                            doneReasoning.Add(clone);
                    }
                    break;
                case "response.completed":
                    if (root.TryGetProperty("response", out var resp)) completed = resp.Clone();
                    break;
                case "codex.rate_limits":
                    rateWindows = WindowsFromRateLimitEvent(root) ?? rateWindows;
                    break;
                case "response.failed":
                    var fe = root.TryGetProperty("response", out var fr) ? fr : root;
                    failure = ErrorFromResponse(fe);
                    failureKind = ClassifyFailure(fe);
                    break;
                case "error":
                    failure = ErrorFromResponse(root);
                    failureKind = ClassifyFailure(root);
                    break;
            }
        }

        string? line;
        while ((line = await reader.ReadLineAsync(ct)) is not null)
        {
            if (line.Length == 0) { Flush(); continue; }                   // blank line = event boundary
            if (line.StartsWith(":", StringComparison.Ordinal)) continue;  // comment / heartbeat
            if (line.StartsWith("event:", StringComparison.Ordinal))
                eventName = line["event:".Length..].Trim();
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (dataBuf.Length > 0) dataBuf.Append('\n');
                dataBuf.Append(line["data:".Length..].TrimStart());
            }
        }
        Flush(); // a trailing event with no closing blank line

        if (failure is not null)
            throw new AiProviderException(failureKind, "ChatGPT backend error: " + failure);

        // Prefer the completed response's output for text + tool calls; fall back to per-item done events.
        var output = completed is { } c && c.TryGetProperty("output", out var outArr) && outArr.ValueKind == JsonValueKind.Array
            ? outArr.EnumerateArray().ToList()
            : doneItems;

        var text = new StringBuilder();
        var calls = new List<AiToolCall>();
        var completedReasoning = new List<JsonElement>();

        foreach (var it in output)
        {
            var itype = it.TryGetProperty("type", out var ty) ? ty.GetString() : null;
            switch (itype)
            {
                case "message":
                    if (it.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
                        foreach (var part in content.EnumerateArray())
                            if (part.TryGetProperty("type", out var pt) && pt.GetString() == "output_text"
                                && part.TryGetProperty("text", out var txt) && txt.ValueKind == JsonValueKind.String)
                                text.Append(txt.GetString());
                    break;
                case "function_call":
                    // Use call_id (call_...), NOT the item id (fc_...): tool results reference call_id.
                    var callId = it.TryGetProperty("call_id", out var cid) && cid.ValueKind == JsonValueKind.String
                        ? cid.GetString()! : Guid.NewGuid().ToString("N");
                    var fname = it.TryGetProperty("name", out var nm) ? nm.GetString() ?? "" : "";
                    var args = it.TryGetProperty("arguments", out var ar) && ar.ValueKind == JsonValueKind.String
                        ? ar.GetString() ?? "{}" : "{}";
                    calls.Add(new AiToolCall(callId, fname, string.IsNullOrWhiteSpace(args) ? "{}" : args));
                    break;
                case "reasoning":
                    completedReasoning.Add(it.Clone());
                    break;
            }
        }

        var finalText = text.Length > 0 ? text.ToString() : (deltaText.Length > 0 ? deltaText.ToString() : null);
        // Echo reasoning only when there are tool calls to reason about (multi-step loop). Prefer the
        // streamed done-items (they carry encrypted_content, required to re-submit under store:false).
        var reasoning = doneReasoning.Count > 0 ? doneReasoning : completedReasoning;
        string? providerState = calls.Count > 0 && reasoning.Count > 0
            ? JsonSerializer.Serialize(reasoning)
            : null;

        return (new AiCompletion(finalText, calls, providerState), rateWindows);
    }

    /// <summary>Map a mid-stream failure payload (arrives after the 200 OK, so <see cref="MapError"/> can't
    /// see it) to an error kind so an auth failure still triggers the failover refresh-retry.</summary>
    private static AiErrorKind ClassifyFailure(JsonElement el)
    {
        var err = el.TryGetProperty("error", out var e) ? e : el;
        string blob;
        if (err.ValueKind == JsonValueKind.String) blob = err.GetString() ?? "";
        else if (err.ValueKind == JsonValueKind.Object)
        {
            var sb = new StringBuilder();
            foreach (var f in new[] { "code", "type", "message" })
                if (err.TryGetProperty(f, out var v))
                    sb.Append(' ').Append(v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText());
            blob = sb.ToString();
        }
        else blob = err.GetRawText();
        blob = blob.ToLowerInvariant();

        if (blob.Contains("invalid_token") || blob.Contains("token_expired") || blob.Contains("unauthorized")
            || blob.Contains("401") || blob.Contains("authenticat") || blob.Contains("invalid_api_key"))
            return AiErrorKind.Auth;
        if (blob.Contains("rate_limit") || blob.Contains("usage_limit") || blob.Contains("quota")
            || blob.Contains("429") || blob.Contains("insufficient"))
            return AiErrorKind.Quota;
        return AiErrorKind.Transient;
    }

    /// <summary>Stable per-conversation session id derived from the first user message, so the backend's
    /// per-session accounting isn't fragmented across the turns of one chat.</summary>
    private static string StableSessionId(IReadOnlyList<AiChatMessage> messages)
    {
        var first = messages.FirstOrDefault(m => m.Role == "user")?.Content;
        if (string.IsNullOrEmpty(first)) return Guid.NewGuid().ToString();
        var hash = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(first));
        return new Guid(hash.AsSpan(0, 16)).ToString();
    }

    // --- rate-limit / usage windows (5-hour "primary" + weekly "secondary") ---

    /// <summary>Read the <c>x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}</c> headers.</summary>
    private static IReadOnlyList<AiRateWindow>? WindowsFromHeaders(HttpResponseMessage res)
    {
        var windows = new List<AiRateWindow>();
        AddHeaderWindow(windows, res, "primary", "5-hour limit");
        AddHeaderWindow(windows, res, "secondary", "Weekly limit");
        return windows.Count > 0 ? windows : null;
    }

    private static void AddHeaderWindow(List<AiRateWindow> into, HttpResponseMessage res, string which, string fallback)
    {
        var used = HeaderDouble(res, $"x-codex-{which}-used-percent");
        if (used is null) return;
        var minutes = HeaderLong(res, $"x-codex-{which}-window-minutes");
        var resetAt = HeaderLong(res, $"x-codex-{which}-reset-at"); // epoch seconds
        into.Add(new AiRateWindow(WindowLabel(minutes, fallback), used.Value, resetAt is null ? null : resetAt * 1000));
    }

    /// <summary>Parse a <c>codex.rate_limits</c> SSE event: <c>rate_limits.{primary,secondary}</c> with
    /// <c>used_percent</c>, <c>window_minutes</c>, <c>reset_at</c>.</summary>
    private static IReadOnlyList<AiRateWindow>? WindowsFromRateLimitEvent(JsonElement root)
    {
        if (!root.TryGetProperty("rate_limits", out var rl) || rl.ValueKind != JsonValueKind.Object) return null;
        var windows = new List<AiRateWindow>();
        if (rl.TryGetProperty("primary", out var p) && p.ValueKind == JsonValueKind.Object)
            windows.Add(WindowFromJson(p, "5-hour limit"));
        if (rl.TryGetProperty("secondary", out var s) && s.ValueKind == JsonValueKind.Object)
            windows.Add(WindowFromJson(s, "Weekly limit"));
        return windows.Count > 0 ? windows : null;
    }

    private static JsonElement? FindWindow(JsonElement obj, params string[] names)
    {
        if (obj.ValueKind != JsonValueKind.Object) return null;
        foreach (var n in names)
            if (obj.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Object) return v;
        return null;
    }

    /// <summary>Tolerant window parse across the header/SSE/usage-endpoint field-name variants.</summary>
    private static AiRateWindow WindowFromJson(JsonElement w, string fallbackLabel)
    {
        double used =
            JsonDouble(w, "used_percent")
            ?? JsonDouble(w, "usage_percent")
            ?? (100 - (JsonDouble(w, "percent_left") ?? JsonDouble(w, "remaining_percent") ?? 100));

        long? minutes = JsonLong(w, "window_minutes")
            ?? (JsonLong(w, "limit_window_seconds") ?? JsonLong(w, "window_seconds")) / 60;

        // reset: epoch seconds (reset_at/resets_at), epoch ms (reset_time_ms), or relative (reset_after_seconds).
        long? resetMs = null;
        var resetSec = JsonLong(w, "reset_at") ?? JsonLong(w, "resets_at") ?? JsonLong(w, "reset_time");
        if (resetSec is not null) resetMs = resetSec * 1000;
        else if (JsonLong(w, "reset_time_ms") is { } ms) resetMs = ms;
        else if ((JsonLong(w, "reset_after_seconds") ?? JsonLong(w, "resets_in_seconds")) is { } rel)
            resetMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + rel * 1000;

        return new AiRateWindow(WindowLabel(minutes, fallbackLabel), Math.Clamp(used, 0, 100), resetMs);
    }

    private static string WindowLabel(long? minutes, string fallback)
    {
        if (minutes is null or <= 0) return fallback;
        var m = minutes.Value;
        if (m < 90) return $"{m}-min limit";
        if (m < 1440) return $"{m / 60}-hour limit";
        var days = m / 1440;
        return days == 7 ? "Weekly limit" : $"{days}-day limit";
    }

    private static AiKeyUsage BuildUsage(IReadOnlyList<AiRateWindow> windows, string? note)
    {
        var summary = string.Join("  ·  ", windows.Select(w => $"{w.Label}: {w.UsedPercent:0.#}% used"));
        if (!string.IsNullOrWhiteSpace(note)) summary += $"  ({note})";
        var nearestReset = windows.Where(w => w.ResetUnixMs is not null)
            .Select(w => w.ResetUnixMs!.Value).DefaultIfEmpty().Min();
        return new AiKeyUsage(true, summary, null, null, null, null, null, null,
            ResetUnixMs: nearestReset == 0 ? null : nearestReset, Windows: windows);
    }

    private static string Ago(DateTimeOffset at)
    {
        var mins = (int)(DateTimeOffset.UtcNow - at).TotalMinutes;
        return mins <= 0 ? "just now" : mins < 60 ? $"{mins}m ago" : $"{mins / 60}h ago";
    }

    private static double? HeaderDouble(HttpResponseMessage res, string name) =>
        double.TryParse(HeaderStr(res, name), System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : null;

    private static long? HeaderLong(HttpResponseMessage res, string name) =>
        long.TryParse(HeaderStr(res, name), out var n) ? n : null;

    private static string? HeaderStr(HttpResponseMessage res, string name) =>
        res.Headers.TryGetValues(name, out var v) ? v.FirstOrDefault() : null;

    private static double? JsonDouble(JsonElement e, string name)
    {
        if (!e.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d)) return d;
        if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(),
            System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var s)) return s;
        return null;
    }

    private static long? JsonLong(JsonElement e, string name)
    {
        if (!e.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
        if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var s)) return s;
        return null;
    }

    private static string ErrorFromResponse(JsonElement el)
    {
        if (el.TryGetProperty("error", out var err))
        {
            if (err.ValueKind == JsonValueKind.String) return err.GetString() ?? err.GetRawText();
            if (err.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String) return m.GetString() ?? "";
            return err.GetRawText();
        }
        return el.GetRawText();
    }

    // --- error mapping (mirrors OpenRouterProvider) ---

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

    private static string ExtractError(string body, HttpStatusCode status)
    {
        var head = $"HTTP {(int)status} {status}";
        var raw = string.IsNullOrWhiteSpace(body) ? "(empty response body)" : Truncate(body.Trim(), 3000);
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var err))
            {
                var msg = err.ValueKind == JsonValueKind.String
                    ? err.GetString()
                    : err.TryGetProperty("message", out var m) ? m.GetString() : null;
                if (!string.IsNullOrWhiteSpace(msg)) return $"{head}: {msg}";
            }
            if (doc.RootElement.TryGetProperty("detail", out var detail) && detail.ValueKind == JsonValueKind.String)
                return $"{head}: {detail.GetString()}";
        }
        catch { /* not JSON */ }
        return $"{head}. {raw}";
    }

    private static string Truncate(string s, int n) => s.Length > n ? s[..n] + "…(truncated)" : s;
}

/// <summary>Lets <see cref="OpenAiProvider"/> (a Singleton) read the connected account id without
/// depending on the Scoped OAuth service directly. Implemented by a small scope-resolving adapter.</summary>
public interface IOpenAiAccountId
{
    Task<string> GetAccountIdAsync(CancellationToken ct);
}

/// <summary>Resolves the Scoped <see cref="IOpenAiOAuthService"/> in a fresh scope so the Singleton
/// provider can read the connected account id (a quick single-row DB lookup).</summary>
public class OpenAiAccountIdAdapter : IOpenAiAccountId
{
    private readonly IServiceScopeFactory _scopes;
    public OpenAiAccountIdAdapter(IServiceScopeFactory scopes) => _scopes = scopes;

    public async Task<string> GetAccountIdAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var svc = scope.ServiceProvider.GetRequiredService<IOpenAiOAuthService>();
        return await svc.GetAccountIdAsync(ct);
    }
}
