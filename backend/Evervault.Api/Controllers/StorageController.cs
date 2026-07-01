using Amazon.S3;
using Evervault.Api.Services;
using Evervault.Api.Services.Ai;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

[ApiController]
[Route("admin/storage")]
[Authorize]
public class StorageController : ControllerBase
{
    private readonly IStorageService _storage;
    private readonly KeyFailoverRunner _failover;
    public StorageController(IStorageService storage, KeyFailoverRunner failover)
    {
        _storage = storage;
        _failover = failover;
    }

    /// <summary>Current storage config (secret masked as a boolean).</summary>
    [HttpGet]
    public async Task<ActionResult<StorageConfigDto>> Get()
    {
        var dto = await _storage.GetAsync();
        return dto is null ? NoContent() : Ok(dto);
    }

    /// <summary>Save the R2 config (secret encrypted before storage).</summary>
    [HttpPut]
    public async Task<ActionResult<StorageConfigDto>> Save(StorageConfigInput input)
    {
        await _storage.SaveAsync(input);
        return Ok(await _storage.GetAsync());
    }

    /// <summary>Validate credentials against R2 (uses the posted values, or the stored ones).</summary>
    [HttpPost("test")]
    public async Task<ActionResult<StorageTestResult>> Test([FromBody] StorageConfigInput? input)
        => Ok(await _storage.TestAsync(input));

    /// <summary>Pre-warm all 30 voice-preview samples into R2 (synthesize via Gemini key-failover,
    /// WAV-encode, upload). Skips ones already present. Lazy GET covers anything not pre-warmed.</summary>
    [HttpPost("samples/generate")]
    public async Task<ActionResult<GenerateSamplesResult>> GenerateSamples(CancellationToken ct)
    {
        int generated = 0, skipped = 0, failed = 0;
        var errors = new List<string>();

        foreach (var voice in VoiceSampleOptions.Voices)
        {
            var key = VoiceSampleOptions.Key(VoiceSampleOptions.Model, voice);
            try
            {
                if (await _storage.ObjectExistsAsync(key, ct)) { skipped++; continue; }

                var (pcm, mime) = await _failover.RunAsync("gemini",
                    (prov, rawKey) => prov.SynthesizeSpeechAsync(
                        rawKey, VoiceSampleOptions.Model, VoiceSampleOptions.SampleText, voice, ct));

                var wav = WavWriter.FromPcm16Mono(pcm, WavWriter.SampleRateFromMime(mime));
                using var ms = new MemoryStream(wav);
                await _storage.PutObjectAsync(key, ms, "audio/wav", ct);
                generated++;
            }
            catch (Exception e)
            {
                failed++;
                errors.Add($"{voice}: {e.Message}");
            }
        }

        return Ok(new GenerateSamplesResult(generated, skipped, failed, errors));
    }

    /// <summary>Status of all 30 voice-preview samples: which already exist in R2 (sorted A–Z).</summary>
    [HttpGet("samples")]
    public async Task<ActionResult<VoiceSamplesStatus>> Samples(CancellationToken ct)
    {
        var prefix = $"voice-samples/{VoiceSampleOptions.Model}/";
        var generated = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            foreach (var key in await _storage.ListKeysAsync(prefix, ct))
            {
                var file = key.Length > prefix.Length ? key[prefix.Length..] : "";   // "{voice}.wav"
                if (file.EndsWith(".wav", StringComparison.OrdinalIgnoreCase))
                    generated.Add(file[..^4]);
            }
        }
        catch (AmazonS3Exception) { /* storage hiccup → degrade to "none generated" */ }

        var voices = VoiceSampleOptions.Voices
            .OrderBy(v => v, StringComparer.Ordinal)
            .Select(v => new VoiceSampleStatusItem(v, generated.Contains(v)))
            .ToList();
        return Ok(new VoiceSamplesStatus(VoiceSampleOptions.Model, voices));
    }

    /// <summary>Generate (or regenerate with ?force=true) a single voice sample and upload it to R2.
    /// Mirrors the lazy synth in VoiceSamplesController but is admin-triggered per voice for live progress.</summary>
    [HttpPost("samples/{voice}")]
    public async Task<IActionResult> GenerateSample(string voice, [FromQuery] bool force, CancellationToken ct)
    {
        if (!VoiceSampleOptions.Voices.Contains(voice))
            return NotFound(new { error = "Unknown voice." });

        var key = VoiceSampleOptions.Key(VoiceSampleOptions.Model, voice);
        try
        {
            if (!force && await _storage.ObjectExistsAsync(key, ct))
                return Ok(new { voice, status = "skipped" });

            var (pcm, mime) = await _failover.RunAsync("gemini",
                (prov, rawKey) => prov.SynthesizeSpeechAsync(
                    rawKey, VoiceSampleOptions.Model, VoiceSampleOptions.SampleText, voice, ct));

            var wav = WavWriter.FromPcm16Mono(pcm, WavWriter.SampleRateFromMime(mime));
            using var ms = new MemoryStream(wav);
            await _storage.PutObjectAsync(key, ms, "audio/wav", ct);
            return Ok(new { voice, status = "generated" });
        }
        catch (AllKeysFailedException ex)
        {
            return StatusCode(502, new { error = "Could not synthesize the voice sample. " + string.Join("; ", ex.Errors) });
        }
        catch (AiProviderException ex)
        {
            return StatusCode(502, new { error = ex.Message });
        }
        catch (InvalidOperationException ex) // storage not configured
        {
            return StatusCode(503, new { error = ex.Message });
        }
        catch (AmazonS3Exception ex)
        {
            return StatusCode(502, new { error = "Storage error while preparing the voice sample: " + ex.Message });
        }
    }
}

public record GenerateSamplesResult(int Generated, int Skipped, int Failed, List<string> Errors);
public record VoiceSampleStatusItem(string Name, bool Generated);
public record VoiceSamplesStatus(string Model, List<VoiceSampleStatusItem> Voices);
