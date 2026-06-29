using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

[ApiController]
[Route("admin/storage")]
[Authorize]
public class StorageController : ControllerBase
{
    private readonly IStorageService _storage;
    public StorageController(IStorageService storage) => _storage = storage;

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
}
