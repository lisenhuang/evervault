using System.Security.Claims;
using Amazon.S3;
using Evervault.Api.Services;
using Evervault.Api.Services.Ai;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

/// <summary>
/// Serves premade per-voice TTS preview samples from R2. Lazy: on a cache miss it synthesizes the
/// fixed sample sentence via Gemini key-failover, WAV-encodes, uploads, then 302-redirects to a
/// presigned URL (mirroring <c>ChatMemoriesController.Audio</c>). Samples are identical for every
/// user, so no Gemini key from the client is needed — generation uses the server keys.
/// Gated to signed-in webapp users (the preview lives in the authenticated settings drawer).
/// </summary>
[ApiController]
[Route("voice-samples")]   // behind UsePathBase("/api") → GET /api/voice-samples/{voice}
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class VoiceSamplesController : ControllerBase
{
    private readonly KeyFailoverRunner _failover;
    private readonly IStorageService _storage;
    private readonly IErrorReportService _errors;

    public VoiceSamplesController(
        KeyFailoverRunner failover, IStorageService storage, IErrorReportService errors)
    {
        _failover = failover;
        _storage = storage;
        _errors = errors;
    }

    private int? Uid =>
        int.TryParse(User.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var id) ? id : null;

    /// <summary>GET /api/voice-samples/{voice}?model=...&amp;inline=true → the WAV sample (generating on
    /// first miss). By default 302-redirects to a presigned R2 URL; with <paramref name="inline"/> the
    /// bytes are streamed back from this origin instead — some browsers' media loaders (notably iOS
    /// Safari) fail with "The operation is not supported" when asked to follow a cross-origin media
    /// redirect, so the webapp preview fetches the bytes inline and decodes them itself.
    /// <paramref name="model"/> defaults to the standard sample model; must be a TTS model.</summary>
    [HttpGet("{voice}")]
    public async Task<IActionResult> Get(
        string voice, [FromQuery] string? model, [FromQuery] bool inline, CancellationToken ct)
    {
        if (!VoiceSampleOptions.Voices.Contains(voice))
            return NotFound(new { error = "Unknown voice." });

        var m = VoiceSampleOptions.ResolveModel(model);
        if (!VoiceSampleOptions.IsAllowedModel(m))
            return BadRequest(new { error = "Unsupported voice model." });

        var key = VoiceSampleOptions.Key(m, voice);

        try
        {
            // 1) Cache hit → inline bytes, or presign + redirect.
            if (await _storage.ObjectExistsAsync(key, ct))
            {
                if (inline)
                {
                    var cached = await _storage.GetObjectBytesAsync(key, ct);
                    if (cached is not null) return File(cached, "audio/wav");
                    // Vanished between HEAD and GET — fall through and regenerate below.
                }
                else
                {
                    var hit = await _storage.GetPresignedGetUrlAsync(key, TimeSpan.FromMinutes(5), ct);
                    if (hit is not null) return Redirect(hit);
                }
            }

            // 2) Miss → synthesize via key failover, WAV-encode, upload.
            var (pcm, mime) = await _failover.RunAsync("gemini",
                (prov, rawKey) => prov.SynthesizeSpeechAsync(
                    rawKey, m, VoiceSampleOptions.SampleText, voice, ct));

            var wav = WavWriter.FromPcm16Mono(pcm, WavWriter.SampleRateFromMime(mime));
            using var ms = new MemoryStream(wav);
            await _storage.PutObjectAsync(key, ms, "audio/wav", ct);

            // 3) Serve the freshly uploaded object.
            if (inline) return File(wav, "audio/wav");
            var url = await _storage.GetPresignedGetUrlAsync(key, TimeSpan.FromMinutes(5), ct);
            return url is null ? StatusCode(503, new { error = "Storage is not configured." }) : Redirect(url);
        }
        catch (AllKeysFailedException ex)
        {
            // Generic message + reference code only — the masked per-key errors stay server-side
            // (they used to be echoed to the client, which leaked provider detail to end users).
            var code = await _errors.CaptureAsync("backend", "voice-sample", Uid, 502,
                $"All Gemini keys failed synthesizing the '{voice}' sample.", string.Join("; ", ex.Errors), Request.Headers.UserAgent.ToString());
            return StatusCode(502, new { error = "Could not prepare the voice sample. Please try again shortly.", referenceCode = code });
        }
        catch (AiProviderException ex)
        {
            var code = await _errors.CaptureAsync("backend", "voice-sample", Uid, 502,
                $"Gemini provider error synthesizing the '{voice}' sample.", ex.Message, Request.Headers.UserAgent.ToString());
            return StatusCode(502, new { error = "Could not prepare the voice sample. Please try again shortly.", referenceCode = code });
        }
        catch (InvalidOperationException ex) // storage not configured (our own message — safe to show)
        {
            return StatusCode(503, new { error = ex.Message });
        }
        catch (AmazonS3Exception ex) // R2 hiccup on exists / upload / presign
        {
            var code = await _errors.CaptureAsync("backend", "voice-sample", Uid, 502,
                $"Storage error while preparing the '{voice}' sample.", ex.Message, Request.Headers.UserAgent.ToString());
            return StatusCode(502, new { error = "Storage error while preparing the voice sample.", referenceCode = code });
        }
    }
}
