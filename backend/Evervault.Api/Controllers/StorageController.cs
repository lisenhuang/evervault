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
}

public record GenerateSamplesResult(int Generated, int Skipped, int Failed, List<string> Errors);
