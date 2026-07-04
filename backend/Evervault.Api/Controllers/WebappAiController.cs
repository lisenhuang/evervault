using System.Text;
using System.Text.Json;
using Evervault.Api.Services.Ai;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

/// <summary>
/// End-user AI proxy for the native app. Mirrors the browser's direct Gemini calls (streaming chat,
/// JSON extraction, transcription, image description, TTS, embeddings, model listing) but runs them
/// SERVER-SIDE through <see cref="KeyFailoverRunner"/> using the system Gemini keys — so the app never
/// asks for or holds a key, and the keys never leave the server. Scoped to the signed-in end-user
/// (cookie OR bearer token). The realtime Live voice call is relayed separately over a WebSocket.
/// </summary>
[ApiController]
[Route("chat/ai")]
[Authorize(AuthenticationSchemes = AuthController.UserAuth)]
public class WebappAiController : ControllerBase
{
    private const string Provider = "gemini";

    private readonly KeyFailoverRunner _failover;
    private readonly ILogger<WebappAiController> _log;

    public WebappAiController(KeyFailoverRunner failover, ILogger<WebappAiController> log)
    {
        _failover = failover;
        _log = log;
    }

    // ---- request/response DTOs (contents/tools/schema are provider-native JSON, mirroring @google/genai) ----

    public record GenerateRequest(string Model, JsonElement Contents, string? SystemInstruction, JsonElement? Tools, JsonElement? GenerationConfig);
    public record GenerateJsonRequest(string Model, JsonElement Contents, string? SystemInstruction, JsonElement? ResponseSchema);
    public record TranscribeRequest(string Model, string AudioBase64, string? MimeType);
    public record DescribeImageRequest(string Model, string ImageBase64, string? MimeType);
    public record TtsRequest(string Model, string Text, string Voice);
    public record EmbedRequest(string Model, string Text, int Dimensions = 1536);
    public record EmbedResponse(float[] Vector);
    public record TextResponse(string Text);
    public record TtsResponse(string Base64, int SampleRate);
    public record ModelsResponse(IReadOnlyList<WebappModelInfo> Models, string? Warning);

    /// <summary>Models available to the system keys, with their generation methods so the app can split
    /// them into text / TTS / live buckets. Best-effort — returns a warning instead of failing.</summary>
    [HttpGet("models")]
    public async Task<ActionResult<ModelsResponse>> Models()
    {
        try
        {
            var models = await _failover.RunAsync(Provider, (p, key) => p.ListModelDetailsAsync(key, HttpContext.RequestAborted));
            return Ok(new ModelsResponse(models, null));
        }
        catch (AllKeysFailedException ex)
        {
            return Ok(new ModelsResponse(Array.Empty<WebappModelInfo>(), "Could not load models — " + string.Join(" ", ex.Errors)));
        }
        catch (AiProviderException ex)
        {
            return Ok(new ModelsResponse(Array.Empty<WebappModelInfo>(), "Could not load models — " + ex.Message));
        }
    }

    /// <summary>Embed one text into a vector (for the memory store). The app posts the returned vector to
    /// /chat/memories exactly like the browser posts its own — the memory endpoints are unchanged.</summary>
    [HttpPost("embed")]
    public async Task<ActionResult<EmbedResponse>> Embed([FromBody] EmbedRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Text)) return BadRequest(new { error = "text is required." });
        try
        {
            var vec = await _failover.RunAsync(Provider,
                (p, key) => p.EmbedAsync(key, req.Model, req.Text, req.Dimensions, HttpContext.RequestAborted));
            return Ok(new EmbedResponse(vec));
        }
        catch (Exception ex) { return Failure(ex); }
    }

    /// <summary>Structured one-shot generation (memory/profile extraction). Returns the model's JSON text.</summary>
    [HttpPost("generate-json")]
    public async Task<ActionResult<TextResponse>> GenerateJson([FromBody] GenerateJsonRequest req)
    {
        var genConfig = new Dictionary<string, object?> { ["responseMimeType"] = "application/json" };
        if (req.ResponseSchema.HasValue) genConfig["responseSchema"] = req.ResponseSchema.Value;

        var payload = new Dictionary<string, object?> { ["contents"] = req.Contents, ["generationConfig"] = genConfig };
        if (!string.IsNullOrWhiteSpace(req.SystemInstruction))
            payload["system_instruction"] = new { parts = new[] { new { text = req.SystemInstruction } } };

        return await OneShot(req.Model, payload);
    }

    /// <summary>Transcribe a spoken clip verbatim (used for push-to-talk + memory).</summary>
    [HttpPost("transcribe")]
    public async Task<ActionResult<TextResponse>> Transcribe([FromBody] TranscribeRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.AudioBase64)) return BadRequest(new { error = "audioBase64 is required." });
        var payload = InlineContent(req.MimeType ?? "audio/wav", req.AudioBase64,
            "Transcribe this audio verbatim. Return ONLY the spoken words, with no commentary, quotes, or " +
            "labels. If there is no intelligible speech, return an empty string.");
        return await OneShot(req.Model, payload);
    }

    /// <summary>Describe an attached image for the searchable memory archive.</summary>
    [HttpPost("describe-image")]
    public async Task<ActionResult<TextResponse>> DescribeImage([FromBody] DescribeImageRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.ImageBase64)) return BadRequest(new { error = "imageBase64 is required." });
        var payload = InlineContent(req.MimeType ?? "image/jpeg", req.ImageBase64,
            "Describe this image in 2-4 factual sentences for a searchable archive: the main subjects, any " +
            "visible text, and the setting. Return ONLY the description, with no preamble or commentary.");
        return await OneShot(req.Model, payload);
    }

    /// <summary>Synthesize a spoken reply. Returns base64 PCM16 + its sample rate (like the browser).</summary>
    [HttpPost("tts")]
    public async Task<ActionResult<TtsResponse>> Tts([FromBody] TtsRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Text)) return BadRequest(new { error = "text is required." });
        try
        {
            var (pcm, mime) = await _failover.RunAsync(Provider,
                (p, key) => p.SynthesizeSpeechAsync(key, req.Model, req.Text, req.Voice, HttpContext.RequestAborted));
            return Ok(new TtsResponse(Convert.ToBase64String(pcm), ParseRate(mime)));
        }
        catch (Exception ex) { return Failure(ex); }
    }

    /// <summary>Streaming text chat (SSE). The app sends provider-native <c>contents</c>/<c>tools</c> and
    /// runs the tool loop itself (one HTTP round per model turn), so it echoes Gemini 3.x function-call
    /// parts — including their <c>thoughtSignature</c> — back verbatim, side-stepping that bug entirely.
    /// We relay Gemini's raw SSE bytes; key-failover only happens before the first byte is written.</summary>
    [HttpPost("generate")]
    public async Task Generate([FromBody] GenerateRequest req)
    {
        var payload = new Dictionary<string, object?> { ["contents"] = req.Contents };
        if (!string.IsNullOrWhiteSpace(req.SystemInstruction))
            payload["system_instruction"] = new { parts = new[] { new { text = req.SystemInstruction } } };
        if (req.Tools.HasValue) payload["tools"] = req.Tools.Value;
        if (req.GenerationConfig.HasValue) payload["generationConfig"] = req.GenerationConfig.Value;
        var body = JsonSerializer.Serialize(payload);

        Response.Headers.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no"; // don't let nginx buffer the stream

        var ct = HttpContext.RequestAborted;
        try
        {
            await _failover.RunAsync(Provider, async (p, key) =>
            {
                await p.StreamGenerateAsync(key, req.Model, body, async (chunk, c) =>
                {
                    await Response.Body.WriteAsync(chunk, c);
                    await Response.Body.FlushAsync(c);
                }, ct);
                return true;
            });
        }
        catch (AllKeysFailedException ex) { await WriteSseError(string.Join(" ", ex.Errors), ct); }
        catch (AiProviderException ex) { await WriteSseError(ex.Message, ct); }
        catch (OperationCanceledException) { /* client disconnected */ }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Streaming generate failed mid-flight");
            await WriteSseError("The reply stream ended unexpectedly.", ct);
        }
    }

    // ---- helpers ----

    private async Task<ActionResult<TextResponse>> OneShot(string model, Dictionary<string, object?> payload)
    {
        var body = JsonSerializer.Serialize(payload);
        try
        {
            var text = await _failover.RunAsync(Provider,
                (p, key) => p.GenerateTextAsync(key, model, body, HttpContext.RequestAborted));
            return Ok(new TextResponse(text.Trim()));
        }
        catch (Exception ex) { return Failure(ex); }
    }

    private static Dictionary<string, object?> InlineContent(string mimeType, string dataBase64, string instruction)
        => new()
        {
            ["contents"] = new[]
            {
                new
                {
                    role = "user",
                    parts = new object[]
                    {
                        new { inlineData = new { mimeType, data = dataBase64 } },
                        new { text = instruction },
                    },
                },
            },
        };

    private ActionResult Failure(Exception ex) => ex switch
    {
        AllKeysFailedException all => StatusCode(502, new { error = "All keys failed: " + string.Join(" ", all.Errors) }),
        AiProviderException p => StatusCode(502, new { error = p.Message }),
        OperationCanceledException => StatusCode(499, new { error = "Request cancelled." }),
        _ => StatusCode(500, new { error = ex.Message }),
    };

    private async Task WriteSseError(string message, CancellationToken ct)
    {
        try
        {
            var evt = "event: error\ndata: " + JsonSerializer.Serialize(new { error = message }) + "\n\n";
            await Response.Body.WriteAsync(Encoding.UTF8.GetBytes(evt), ct);
            await Response.Body.FlushAsync(ct);
        }
        catch { /* client gone */ }
    }

    private static int ParseRate(string? mime)
    {
        if (string.IsNullOrEmpty(mime)) return 24000;
        var m = System.Text.RegularExpressions.Regex.Match(mime, @"rate=(\d+)");
        return m.Success ? int.Parse(m.Groups[1].Value) : 24000;
    }
}
