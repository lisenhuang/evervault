using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Evervault.Api.Controllers;

/// <summary>
/// Admin-only configuration of the web-search (Brave Search API) key, encrypted at rest. Its presence is
/// what enables the /webapp assistant to search the live web. Uses the default (AdminCookie) scheme.
/// </summary>
[ApiController]
[Route("admin/search/brave")]   // behind UsePathBase("/api") → /api/admin/search/brave
[Authorize]
public class BraveSearchController : ControllerBase
{
    private readonly IBraveSearchService _brave;

    public BraveSearchController(IBraveSearchService brave) => _brave = brave;

    /// <summary>Current web-search config (API key masked to a boolean + hint).</summary>
    [HttpGet]
    public async Task<ActionResult<BraveSearchConfigDto>> Get()
    {
        var dto = await _brave.GetAsync();
        return dto is null ? NoContent() : Ok(dto);
    }

    /// <summary>Save the web-search config (API key encrypted before storage; blank keeps the stored one).</summary>
    [HttpPut]
    public async Task<ActionResult<BraveSearchConfigDto>> Save(BraveSearchConfigInput input)
    {
        await _brave.SaveAsync(input);
        return Ok(await _brave.GetAsync());
    }
}
