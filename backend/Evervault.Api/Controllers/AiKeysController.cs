using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

[ApiController]
[Route("admin/ai/keys")]
[Authorize]
public class AiKeysController : ControllerBase
{
    private readonly IAiKeyService _keys;
    public AiKeysController(IAiKeyService keys) => _keys = keys;

    /// <summary>All stored keys per provider (masked).</summary>
    [HttpGet]
    public async Task<ActionResult<AiKeysDto>> Get() => Ok(await _keys.GetAsync());

    /// <summary>Append new keys for a provider (one per line). Existing keys are preserved.</summary>
    [HttpPost("{provider}")]
    public async Task<ActionResult<AiKeysDto>> Add(string provider, [FromBody] AddKeysInput input)
    {
        try { return Ok(await _keys.AddKeysAsync(provider, input.RawText ?? "")); }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
    }

    /// <summary>Delete a single stored key.</summary>
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        await _keys.DeleteAsync(id);
        return NoContent();
    }

    /// <summary>Validate every stored key for a provider against the live API.</summary>
    [HttpPost("{provider}/check")]
    public async Task<ActionResult<CheckKeysResult>> Check(string provider)
    {
        try { return Ok(new CheckKeysResult(await _keys.CheckAsync(provider))); }
        catch (ArgumentException ex) { return BadRequest(new { error = ex.Message }); }
    }
}
