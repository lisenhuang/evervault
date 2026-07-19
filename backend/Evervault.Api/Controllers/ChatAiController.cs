using System.Security.Claims;
using System.Text;
using System.Text.RegularExpressions;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services;
using Evervault.Api.Services.Ai;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Keyless AI surface for the public /webapp end-user chat. The webapp no longer holds a Gemini key:
/// <list type="bullet">
/// <item><c>GET  config</c> — which models/voice the admin picked for the webapp.</item>
/// <item><c>POST live-token</c> — mint a short-lived Live ephemeral token so the browser streams the
///   realtime call <b>directly to Google</b> (no audio through us), key stays server-side.</item>
/// <item><c>* gemini/{**path}</c> — a thin reverse-proxy for the non-Live REST calls (text streaming,
///   TTS, embeddings): forwards to the Gemini API injecting a pooled key with failover.</item>
/// <item><c>POST text</c> — server-side text chat honoring the admin's primary text model even when it
///   isn't Gemini (ChatGPT runs on the admin's connected account), with fallback-leg failover.</item>
/// </list>
/// The real keys live only in the backend (encrypted <see cref="AiKey"/> pool) and are selected by
/// <see cref="KeyFailoverRunner"/>; they never reach the client and only the masked hint is ever logged.
/// Gated to signed-in webapp users (the <c>ev_user</c> cookie).
/// </summary>
[ApiController]
[Route("chat/ai")]   // behind UsePathBase("/api") → /api/chat/ai/*
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatAiController : ControllerBase
{
    private readonly KeyFailoverRunner _failover;
    private readonly GeminiProvider _gemini;
    private readonly AppDbContext _db;
    private readonly IErrorReportService _errors;
    private readonly IAiCallLogService _callLog;
    private readonly VoiceReplySynthesizer _voiceReplies;

    public ChatAiController(
        KeyFailoverRunner failover, GeminiProvider gemini, AppDbContext db,
        IErrorReportService errors, IAiCallLogService callLog, VoiceReplySynthesizer voiceReplies)
    {
        _failover = failover;
        _gemini = gemini;
        _db = db;
        _errors = errors;
        _callLog = callLog;
        _voiceReplies = voiceReplies;
    }

    private int? Uid =>
        int.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var id) ? id : null;

    private string UserAgent => Request.Headers.UserAgent.ToString();

    // Only the Gemini methods the webapp client actually calls may be proxied, so this can never be an
    // open relay for arbitrary endpoints. Model listing is intentionally excluded — models come from config.
    private static readonly Regex AllowedProxyPath = new(
        @"^v1beta/models/[^/:]+:(generateContent|streamGenerateContent|embedContent|batchEmbedContents)$",
        RegexOptions.Compiled);

    public record WebappConfigDto(
        string TextModel, string AudioModel, string LiveModel, string DefaultVoice, bool ServerChat,
        int LiveIdleTimeoutSeconds);
    public record LiveTokenDto(string Token, string? ExpiresAt);

    /// <summary>The models + default voice the admin chose for the webapp (with safe fallbacks).
    /// <c>TextModel</c> is always a Gemini model (projected via <see cref="WebappAiDefaults.BrowserText"/>) —
    /// it's what the browser calls directly through the pooled-key proxy for transcription, TTS, embeddings,
    /// and memory extraction. <c>ServerChat</c> tells the client that the admin's primary text model is NOT
    /// Gemini (e.g. ChatGPT), so text turns should go through <c>POST text</c>, where the server holds the
    /// credentials and runs primary→fallback. The model id itself is deliberately not exposed.
    /// <c>LiveIdleTimeoutSeconds</c> is the admin's auto-hang-up window for an idle live call (0 = never);
    /// it's additive, so an older client that ignores it just keeps its built-in 60s default.</summary>
    [HttpGet("config")]
    public async Task<ActionResult<WebappConfigDto>> Config()
    {
        var c = await _db.WebappAiConfigs.AsNoTracking().FirstOrDefaultAsync();
        return Ok(new WebappConfigDto(
            WebappAiDefaults.BrowserText(c), WebappAiDefaults.Audio(c), WebappAiDefaults.Live(c), WebappAiDefaults.VoiceOf(c),
            WebappAiDefaults.TextProviderOf(c) != WebappAiDefaults.GeminiProvider,
            WebappAiDefaults.LiveIdle(c)));
    }

    // --- Server-side voice-message reply audio ---
    //
    // The webapp's spoken reply is normally synthesized in the browser (TTS via the Gemini proxy) AFTER the
    // text reply finishes. On iOS Safari, backgrounding the tab suspends the page and kills that in-flight
    // request, so a user who fires a voice message and switches away returns to text with no voice. These two
    // endpoints move synthesis server-side: the browser posts the finished reply text, we synthesize on a
    // background worker that runs regardless of whether the tab is still open, and the client polls for the
    // clip (right away, and again whenever it comes back to the foreground). Additive + keyless — the old
    // client that never calls these keeps working unchanged.

    public record VoiceReplyRequest(string? ReplyId, string? Text, string? Voice);

    // Bound the synthesized text so one request can't queue an unbounded TTS job. Normal spoken replies are
    // a few sentences; anything past this is clipped (the provider would reject a huge input anyway).
    private const int MaxTtsChars = 8000;

    /// <summary>Kick off server-side synthesis of a spoken reply. The browser supplies a client-generated
    /// <c>replyId</c> (the assistant message id) plus the finished reply text and the chosen voice; we queue
    /// the synthesis on a background worker and return immediately. Idempotent — re-posting the same replyId
    /// just reads back the current status. 202 with <c>{status}</c> = pending | ready | failed.</summary>
    [HttpPost("voice-reply")]
    public async Task<IActionResult> StartVoiceReply([FromBody] VoiceReplyRequest req)
    {
        if (Uid is not int uid) return Unauthorized();

        var replyId = (req.ReplyId ?? "").Trim();
        var text = (req.Text ?? "").Trim();
        if (replyId.Length is 0 or > 200) return BadRequest(new { error = "A valid replyId is required." });
        if (text.Length == 0) return BadRequest(new { error = "No text to synthesize." });
        if (text.Length > MaxTtsChars) text = text[..MaxTtsChars];

        var c = await _db.WebappAiConfigs.AsNoTracking().FirstOrDefaultAsync();
        var model = WebappAiDefaults.Audio(c);
        var voice = string.IsNullOrWhiteSpace(req.Voice) ? WebappAiDefaults.VoiceOf(c) : req.Voice!.Trim();
        if (voice.Length > 64) voice = voice[..64];

        var status = _voiceReplies.Enqueue(uid, replyId, text, voice, model, UserAgent);
        return StatusCode(StatusCodes.Status202Accepted, new { status = status.ToString().ToLowerInvariant(), replyId });
    }

    /// <summary>Poll a spoken reply's synthesis. <c>ready</c> carries the raw mono PCM16 as base64 plus its
    /// sample rate (exactly what the browser's PCM player consumes); <c>pending</c> means keep waiting;
    /// <c>failed</c> means synthesis gave up (the client reveals the text without audio); a 404 means we have
    /// no record of it (never started, or swept — the client re-kicks).</summary>
    [HttpGet("voice-reply/{replyId}")]
    public IActionResult GetVoiceReply(string replyId)
    {
        if (Uid is not int uid) return Unauthorized();

        var result = _voiceReplies.TryGet(uid, (replyId ?? "").Trim());
        if (result is null) return NotFound(new { status = "unknown" });

        return result.Status switch
        {
            VoiceReplySynthesizer.ReplyStatus.Ready =>
                Ok(new { status = "ready", base64 = Convert.ToBase64String(result.Pcm!), sampleRate = result.SampleRate }),
            VoiceReplySynthesizer.ReplyStatus.Failed => Ok(new { status = "failed" }),
            _ => Ok(new { status = "pending" }),
        };
    }

    // --- Server-side text chat (used when the primary text model isn't Gemini) ---

    public record WebappChatToolDto(string? Name, string? Description, string? ParametersJson);
    public record WebappChatRequest(List<AiChatMessage>? Messages, string? System, List<WebappChatToolDto>? Tools);

    // NDJSON frames are serialized camelCase so the record-typed fields (tool calls) match the
    // anonymous lowercase ones — the same convention the JSON endpoints use.
    private static readonly System.Text.Json.JsonSerializerOptions FrameJson =
        new(System.Text.Json.JsonSerializerDefaults.Web);

    private const string ChatUnavailable = "The AI service is temporarily unavailable. Please try again.";

    /// <summary>One text-chat round for the /webapp, run server-side so a ChatGPT primary (admin's
    /// connected account — its token must never reach a browser) is usable from the keyless client.
    /// Tries the admin's primary leg, then the fallback leg, switching only while nothing has been
    /// streamed yet. Streams NDJSON frames: <c>{type:"delta",text}</c> per token, then either
    /// <c>{type:"toolCalls",text,calls,providerState}</c> (the client executes the tools and re-POSTs
    /// with the results appended — the tool loop is client-driven) or <c>{type:"done",text}</c>;
    /// failures after first byte end with <c>{type:"error",error,referenceCode}</c>. Failures before
    /// first byte return a plain 502 <c>{error, referenceCode}</c> like the Gemini proxy.</summary>
    [HttpPost("text")]
    public async Task Text([FromBody] WebappChatRequest req)
    {
        var ct = HttpContext.RequestAborted;
        var c = await _db.WebappAiConfigs.AsNoTracking().FirstOrDefaultAsync(ct);

        // The client owns the transcript, but the system slot is a dedicated field: drop any
        // system rows smuggled into the transcript itself.
        var messages = (req.Messages ?? new()).Where(m => m.Role is "user" or "assistant" or "tool").ToList();
        if (!string.IsNullOrWhiteSpace(req.System)) messages.Insert(0, new AiChatMessage("system", req.System));

        // ParametersJson is parsed unguarded inside the providers' wire translation — sanitize here so a
        // malformed schema from a client can't turn into an unhandled 500 instead of the 502 contract.
        var tools = (req.Tools ?? new())
            .Where(t => !string.IsNullOrWhiteSpace(t.Name))
            .Select(t => new AiToolSchema(t.Name!.Trim(), t.Description ?? "", SafeJsonObject(t.ParametersJson)))
            .ToList();

        // Primary leg, then the configured fallback leg (skipping an exact duplicate).
        var legs = new List<(string Provider, string Model, string? Reasoning)>
        {
            (WebappAiDefaults.TextProviderOf(c), WebappAiDefaults.Text(c), c?.TextReasoning),
        };
        if (WebappAiDefaults.TextFallback(c) is { } fb && (fb.Provider != legs[0].Provider || fb.Model != legs[0].Model))
            legs.Add(fb);

        // Once any frame reaches the client the turn is committed: retries (next key, refreshed
        // token, the other leg) would replay already-shown text, so they're cut off past this point.
        var flushed = false;
        async Task WriteFrameAsync(object frame)
        {
            if (!Response.HasStarted)
            {
                Response.StatusCode = StatusCodes.Status200OK;
                Response.ContentType = "application/x-ndjson";
                Response.Headers["X-Accel-Buffering"] = "no"; // nginx: pass chunks through unbuffered
                HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            }
            flushed = true;
            await Response.WriteAsync(System.Text.Json.JsonSerializer.Serialize(frame, FrameJson) + "\n", ct);
            await Response.Body.FlushAsync(ct);
        }

        var failures = new List<string>();
        foreach (var (provider, model, reasoning) in legs)
        {
            var options = new AiGenerationOptions(reasoning);
            var ctx = new AiCallContext { Area = "webapp-chat", Model = model, EndUserId = Uid };
            // First real provider failure of this leg. A retry after first byte trips the flushed
            // guard below, and that sentinel would otherwise replace the diagnosable error in the report.
            Exception? legError = null;
            try
            {
                var completion = await _failover.RunAsync(provider, async (p, key) =>
                {
                    if (flushed)
                        throw new AiProviderException(AiErrorKind.Other,
                            "The response already started streaming; this turn cannot be retried.");
                    try
                    {
                        return await p.CompleteStreamingAsync(key, model, messages, tools, options,
                            delta => WriteFrameAsync(new { type = "delta", text = delta }), ct);
                    }
                    catch (AiProviderException ex)
                    {
                        legError ??= ex;
                        throw;
                    }
                }, log: ctx, usageOf: r => r.Usage);

                if (completion.ToolCalls.Count > 0)
                {
                    await WriteFrameAsync(new
                    {
                        type = "toolCalls",
                        text = completion.Text,
                        calls = completion.ToolCalls,
                        providerState = completion.ProviderState,
                    });
                    return;
                }

                // A leg that returns no tool calls AND no text produced nothing the webapp can show —
                // e.g. a reasoning model that spent the turn on reasoning tokens without emitting a final
                // message. The HTTP call still succeeded (it logs "ok" with token usage), so the catch
                // below never sees it. As long as nothing has streamed to the client yet, treat the empty
                // completion as a leg failure and fall through to the configured fallback model, instead of
                // returning an empty reply the webapp renders as "(no response)".
                if (string.IsNullOrWhiteSpace(completion.Text) && !flushed)
                {
                    failures.Add($"{provider}/{model}: empty completion (no text or tool calls).");
                    continue;
                }

                // `text` is the authoritative full reply — non-streaming legs (Gemini fallback)
                // deliver everything here; streamed legs let the client fill any missed tail.
                await WriteFrameAsync(new { type = "done", text = completion.Text });
                return;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return; // client navigated away / aborted mid-stream
            }
            catch (Exception ex) when (ex is AllKeysFailedException or AiProviderException
                or OperationCanceledException or HttpRequestException or IOException)
            {
                // OperationCanceledException with the client still connected is a provider-side
                // timeout; HttpRequestException/IOException are transport failures below the
                // providers' error mapping. All are leg failures, not client aborts — keep the
                // 502-with-reference-code contract and let the next leg try.
                var cause = flushed && legError is not null && ex is AiProviderException { Kind: AiErrorKind.Other }
                    ? legError // the flushed-guard sentinel — the real failure came just before it
                    : ex;
                failures.Add($"{provider}/{model}: " +
                    (cause is AllKeysFailedException all ? string.Join("; ", all.Errors) : cause.Message));
                if (flushed)
                {
                    var midCode = await _errors.CaptureAsync("backend", "ai-chat", Uid, 502,
                        "AI text turn failed mid-stream.", string.Join(" | ", failures), UserAgent);
                    try
                    {
                        await WriteFrameAsync(new { type = "error", error = ChatUnavailable, referenceCode = midCode });
                    }
                    catch (OperationCanceledException) { /* client gone — the report is already captured */ }
                    return;
                }
                // Nothing sent yet — fall through to the next leg (typically ChatGPT → Gemini).
            }
        }

        var code = await _errors.CaptureAsync("backend", "ai-chat", Uid, 502,
            "All text-chat legs failed.", string.Join(" | ", failures), UserAgent);
        try
        {
            Response.StatusCode = StatusCodes.Status502BadGateway;
            await Response.WriteAsJsonAsync(new { error = ChatUnavailable, referenceCode = code }, ct);
        }
        catch (OperationCanceledException) { /* client gone — the report is already captured */ }
    }

    /// <summary>Mint a short-lived, single-use Live ephemeral token for the realtime call. The browser
    /// connects to Google directly with this token; our real key never leaves the server. <paramref name="attempt"/>
    /// rotates to the next pooled key, so the client can re-request a token on another key if the minted one's
    /// key turns out to be exhausted mid-call.</summary>
    [HttpPost("live-token")]
    public async Task<ActionResult<LiveTokenDto>> LiveToken([FromQuery] int attempt = 0)
    {
        var c = await _db.WebappAiConfigs.AsNoTracking().FirstOrDefaultAsync();
        var liveModel = WebappAiDefaults.Live(c);
        try
        {
            var (token, expiresAt) = await _failover.RunAsync("gemini",
                (_, rawKey) => _gemini.CreateLiveEphemeralTokenAsync(rawKey, liveModel, HttpContext.RequestAborted),
                skip: attempt < 0 ? 0 : attempt,
                log: new AiCallContext { Area = "live-token", Model = liveModel, EndUserId = Uid });
            return Ok(new LiveTokenDto(token, expiresAt));
        }
        catch (AllKeysFailedException ex)
        {
            // Capture logs the masked per-key hints (never a raw key) alongside the reference code.
            var code = await _errors.CaptureAsync("backend", "live-token", Uid, 502,
                "All Gemini keys failed while minting a live token.", string.Join("; ", ex.Errors), UserAgent);
            return StatusCode(502, new { error = "Live audio is temporarily unavailable. Please try again shortly.", referenceCode = code });
        }
        catch (AiProviderException ex)
        {
            var code = await _errors.CaptureAsync("backend", "live-token", Uid, 502,
                "Gemini provider error while minting a live token.", ex.Message, UserAgent);
            return StatusCode(502, new { error = "Live audio is temporarily unavailable.", referenceCode = code });
        }
    }

    // --- REST reverse-proxy (text streaming, TTS, embeddings) ---

    [HttpPost("gemini/{**path}")]
    public Task ProxyPost(string path) => ProxyAsync(path);

    [HttpGet("gemini/{**path}")]
    public Task ProxyGet(string path) => ProxyAsync(path);

    private async Task ProxyAsync(string path)
    {
        var ct = HttpContext.RequestAborted;

        if (string.IsNullOrEmpty(path) || !AllowedProxyPath.IsMatch(path))
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            await Response.WriteAsJsonAsync(new { error = "Not found." }, ct);
            return;
        }

        // Buffer the request body so it can be re-sent verbatim to the next key on failover.
        byte[]? body = null;
        if (HttpMethods.IsPost(Request.Method))
        {
            using var ms = new MemoryStream();
            await Request.Body.CopyToAsync(ms, ct);
            body = ms.ToArray();
        }
        var contentType = Request.ContentType;

        // Rebuild the query without any client-supplied `key` (we inject our own via header), so a
        // placeholder key from the SDK can't override the pooled key we set upstream.
        var pairs = Request.Query
            .Where(kv => !string.Equals(kv.Key, "key", StringComparison.OrdinalIgnoreCase))
            .Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value.ToString())}");
        var qs = string.Join("&", pairs);
        var pathAndQuery = "/" + path + (qs.Length > 0 ? "?" + qs : "");
        var method = new HttpMethod(Request.Method);

        // Log the call at the failover choke point; token counts (in the streamed body) are patched on
        // once streaming completes. Only the chat methods carry a meaningful usageMetadata worth sniffing.
        var (area, model) = DescribeProxy(path);
        var ctx = new AiCallContext { Area = area, Model = model, EndUserId = Uid };

        try
        {
            using var upstream = await _failover.RunAsync("gemini",
                (_, rawKey) => _gemini.ProxyRestAsync(rawKey, method, pathAndQuery, body, contentType, ct),
                log: ctx);

            Response.StatusCode = (int)upstream.StatusCode;
            Response.ContentType = upstream.Content.Headers.ContentType?.ToString() ?? "application/json";
            // Stream token-by-token: disable output buffering and flush each chunk so SSE reaches the client live.
            HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            // Keep only a bounded tail of the (chat) response so the final usageMetadata can be read back
            // without holding the whole stream in memory. The bytes still go to the browser unchanged.
            var captureUsage = area == "webapp-chat" && ctx.LogId is not null;
            var tail = new UsageTail(captureUsage);

            await using var src = await upstream.Content.ReadAsStreamAsync(ct);
            var buf = new byte[16 * 1024];
            int n;
            while ((n = await src.ReadAsync(buf, ct)) > 0)
            {
                await Response.Body.WriteAsync(buf.AsMemory(0, n), ct);
                await Response.Body.FlushAsync(ct);
                tail.Append(buf, n);
            }

            if (captureUsage && ctx.LogId is int logId && tail.Sniff() is { } usage)
                await _callLog.UpdateTokensAsync(logId, usage);
        }
        catch (AllKeysFailedException ex)
        {
            // Capture logs the masked per-key hints (never a raw key); the client gets a generic
            // message plus the reference code an admin can search in /admin/errors.
            await FailAsync(ct, "All Gemini keys failed on the AI proxy.", string.Join("; ", ex.Errors));
        }
        catch (AiProviderException ex)
        {
            await FailAsync(ct, "Gemini provider error on the AI proxy.", ex.Message);
        }
        catch (OperationCanceledException)
        {
            // Client navigated away / aborted mid-stream — nothing to return.
        }
    }

    /// <summary>Client-supplied JSON that must be a valid object on the provider wire; anything else
    /// (malformed, non-object) becomes the empty schema.</summary>
    private static string SafeJsonObject(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return "{}";
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object ? json : "{}";
        }
        catch
        {
            return "{}";
        }
    }

    private async Task FailAsync(CancellationToken ct, string message, string detail)
    {
        // Always record the report (the code stays greppable in logs even mid-stream), but only send
        // an error body if we haven't already started streaming a (200) response.
        var code = await _errors.CaptureAsync("backend", "ai-proxy", Uid, 502, message, detail, UserAgent);
        if (Response.HasStarted) return;
        Response.StatusCode = StatusCodes.Status502BadGateway;
        await Response.WriteAsJsonAsync(
            new { error = "The AI service is temporarily unavailable. Please try again.", referenceCode = code }, ct);
    }

    // Classify a proxied path ("v1beta/models/{model}:{method}") into a log area + model: the chat methods
    // (generate/streamGenerateContent) are "webapp-chat"; embed{Content,BatchEmbedContents} are "embed".
    private static readonly Regex ProxyPathRe = new(@"models/([^/:]+):(\w+)", RegexOptions.Compiled);

    private static (string Area, string? Model) DescribeProxy(string path)
    {
        var m = ProxyPathRe.Match(path ?? "");
        var model = m.Success ? m.Groups[1].Value : null;
        var method = m.Success ? m.Groups[2].Value : "";
        var area = method.Contains("embed", StringComparison.OrdinalIgnoreCase) ? "embed" : "webapp-chat";
        return (area, model);
    }

    /// <summary>Keeps a bounded rolling tail of a streamed Gemini response so the final
    /// <c>usageMetadata</c> token counts can be recovered <b>after</b> the bytes have been forwarded to the
    /// browser unchanged. Best-effort and no-op when capture is off (non-chat calls, or no row to patch).</summary>
    private sealed class UsageTail
    {
        private const int Cap = 96 * 1024;   // usageMetadata is in the final frame; the tail is plenty.
        private readonly bool _on;
        private readonly Queue<byte[]> _chunks = new();
        private int _bytes;

        public UsageTail(bool on) => _on = on;

        public void Append(byte[] buf, int n)
        {
            if (!_on || n <= 0) return;
            var chunk = buf.AsSpan(0, n).ToArray();
            _chunks.Enqueue(chunk);
            _bytes += chunk.Length;
            while (_bytes > Cap && _chunks.Count > 1) _bytes -= _chunks.Dequeue().Length;
        }

        public AiUsage? Sniff()
        {
            if (!_on || _bytes == 0) return null;
            var all = new byte[_bytes];
            var off = 0;
            foreach (var c in _chunks) { Buffer.BlockCopy(c, 0, all, off, c.Length); off += c.Length; }
            var text = Encoding.UTF8.GetString(all);

            // Take the LAST occurrence of each field — a streamed response repeats usageMetadata as it grows;
            // the final frame carries the authoritative totals.
            int? Last(string field)
            {
                var ms = Regex.Matches(text, "\"" + field + "\"\\s*:\\s*(\\d+)");
                return ms.Count > 0 && int.TryParse(ms[^1].Groups[1].Value, out var v) ? v : null;
            }

            var prompt = Last("promptTokenCount");
            var completion = Last("candidatesTokenCount");
            var total = Last("totalTokenCount");
            return prompt is null && completion is null && total is null ? null : new AiUsage(prompt, completion, total);
        }
    }
}
