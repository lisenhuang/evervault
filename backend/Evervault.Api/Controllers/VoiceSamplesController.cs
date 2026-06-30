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
    private readonly ILogger<VoiceSamplesController> _log;

    public VoiceSamplesController(
        KeyFailoverRunner failover, IStorageService storage, ILogger<VoiceSamplesController> log)
    {
        _failover = failover;
        _storage = storage;
        _log = log;
    }

    /// <summary>GET /api/voice-samples/{voice} → 302 to a presigned R2 URL (generating on first miss).</summary>
    [HttpGet("{voice}")]
    public async Task<IActionResult> Get(string voice, CancellationToken ct)
    {
        if (!VoiceSampleOptions.Voices.Contains(voice))
            return NotFound(new { error = "Unknown voice." });

        var key = VoiceSampleOptions.Key(VoiceSampleOptions.Model, voice);

        try
        {
            // 1) Cache hit → presign + redirect.
            if (await _storage.ObjectExistsAsync(key, ct))
            {
                var hit = await _storage.GetPresignedGetUrlAsync(key, TimeSpan.FromMinutes(5), ct);
                if (hit is not null) return Redirect(hit);
            }

            // 2) Miss → synthesize via key failover, WAV-encode, upload.
            var (pcm, mime) = await _failover.RunAsync("gemini",
                (prov, rawKey) => prov.SynthesizeSpeechAsync(
                    rawKey, VoiceSampleOptions.Model, VoiceSampleOptions.SampleText, voice, ct));

            var wav = WavWriter.FromPcm16Mono(pcm, WavWriter.SampleRateFromMime(mime));
            using var ms = new MemoryStream(wav);
            await _storage.PutObjectAsync(key, ms, "audio/wav", ct);

            // 3) Serve the freshly uploaded object.
            var url = await _storage.GetPresignedGetUrlAsync(key, TimeSpan.FromMinutes(5), ct);
            return url is null ? StatusCode(503, new { error = "Storage is not configured." }) : Redirect(url);
        }
        catch (AllKeysFailedException ex)
        {
            _log.LogWarning("Voice sample {Voice}: all keys failed: {Errors}", voice, string.Join("; ", ex.Errors));
            return StatusCode(502, new { error = "Could not synthesize the voice sample. " + string.Join("; ", ex.Errors) });
        }
        catch (AiProviderException ex)
        {
            _log.LogWarning("Voice sample {Voice}: {Message}", voice, ex.Message);
            return StatusCode(502, new { error = ex.Message });
        }
        catch (InvalidOperationException ex) // storage not configured
        {
            return StatusCode(503, new { error = ex.Message });
        }
        catch (AmazonS3Exception ex) // R2 hiccup on exists / upload / presign
        {
            _log.LogWarning("Voice sample {Voice}: storage error: {Message}", voice, ex.Message);
            return StatusCode(502, new { error = "Storage error while preparing the voice sample." });
        }
    }
}
