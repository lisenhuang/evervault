using System.Text.RegularExpressions;
using Evervault.Api.Data;
using Evervault.Api.Models;
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
    private readonly ILogger<ChatAiController> _log;

    public ChatAiController(
        KeyFailoverRunner failover, GeminiProvider gemini, AppDbContext db, ILogger<ChatAiController> log)
    {
        _failover = failover;
        _gemini = gemini;
        _db = db;
        _log = log;
    }

    // Only the Gemini methods the webapp client actually calls may be proxied, so this can never be an
    // open relay for arbitrary endpoints. Model listing is intentionally excluded — models come from config.
    private static readonly Regex AllowedProxyPath = new(
        @"^v1beta/models/[^/:]+:(generateContent|streamGenerateContent|embedContent|batchEmbedContents)$",
        RegexOptions.Compiled);

    public record WebappConfigDto(string TextModel, string AudioModel, string LiveModel, string DefaultVoice);
    public record LiveTokenDto(string Token, string? ExpiresAt);

    /// <summary>The models + default voice the admin chose for the webapp (with safe fallbacks).</summary>
    [HttpGet("config")]
    public async Task<ActionResult<WebappConfigDto>> Config()
    {
        var c = await _db.WebappAiConfigs.AsNoTracking().FirstOrDefaultAsync();
        return Ok(new WebappConfigDto(
            WebappAiDefaults.Text(c), WebappAiDefaults.Audio(c), WebappAiDefaults.Live(c), WebappAiDefaults.VoiceOf(c)));
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
                skip: attempt < 0 ? 0 : attempt);
            return Ok(new LiveTokenDto(token, expiresAt));
        }
        catch (AllKeysFailedException ex)
        {
            _log.LogWarning("Webapp live-token: all gemini keys failed: {Errors}", string.Join("; ", ex.Errors));
            return StatusCode(502, new { error = "Live audio is temporarily unavailable. Please try again shortly." });
        }
        catch (AiProviderException ex)
        {
            _log.LogWarning("Webapp live-token: {Message}", ex.Message);
            return StatusCode(502, new { error = "Live audio is temporarily unavailable." });
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

        try
        {
            using var upstream = await _failover.RunAsync("gemini",
                (_, rawKey) => _gemini.ProxyRestAsync(rawKey, method, pathAndQuery, body, contentType, ct));

            Response.StatusCode = (int)upstream.StatusCode;
            Response.ContentType = upstream.Content.Headers.ContentType?.ToString() ?? "application/json";
            // Stream token-by-token: disable output buffering and flush each chunk so SSE reaches the client live.
            HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            await using var src = await upstream.Content.ReadAsStreamAsync(ct);
            var buf = new byte[16 * 1024];
            int n;
            while ((n = await src.ReadAsync(buf, ct)) > 0)
            {
                await Response.Body.WriteAsync(buf.AsMemory(0, n), ct);
                await Response.Body.FlushAsync(ct);
            }
        }
        catch (AllKeysFailedException ex)
        {
            // Log the masked per-key hints (never a raw key); return a generic message to the client.
            _log.LogWarning("Webapp AI proxy: all gemini keys failed: {Errors}", string.Join("; ", ex.Errors));
            await FailAsync(ct);
        }
        catch (AiProviderException ex)
        {
            _log.LogWarning("Webapp AI proxy: {Message}", ex.Message);
            await FailAsync(ct);
        }
        catch (OperationCanceledException)
        {
            // Client navigated away / aborted mid-stream — nothing to return.
        }
    }

    private async Task FailAsync(CancellationToken ct)
    {
        // Only send an error body if we haven't already started streaming a (200) response.
        if (Response.HasStarted) return;
        Response.StatusCode = StatusCodes.Status502BadGateway;
        await Response.WriteAsJsonAsync(new { error = "The AI service is temporarily unavailable. Please try again." }, ct);
    }
}
