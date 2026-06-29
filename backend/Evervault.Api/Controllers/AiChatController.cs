using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services.Ai;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

[ApiController]
[Route("admin/ai")]
[Authorize]
public class AiChatController : ControllerBase
{
    private readonly AgentService _agent;
    private readonly KeyFailoverRunner _failover;
    private readonly AppDbContext _db;

    public AiChatController(AgentService agent, KeyFailoverRunner failover, AppDbContext db)
    {
        _agent = agent;
        _failover = failover;
        _db = db;
    }

    public record ModelsResult(string Provider, IReadOnlyList<AiModelInfo> Models, string? Warning);
    public record ChatConfigDto(string? SelectedProvider, string? GeminiModel, string? OpenRouterModel);
    public record ChatConfigInput(string? SelectedProvider, string? GeminiModel, string? OpenRouterModel);

    /// <summary>Live model list for a provider (free/paid + pricing where exposed). Goes through failover.</summary>
    [HttpGet("models")]
    public async Task<ActionResult<ModelsResult>> Models([FromQuery] string provider)
    {
        var p = (provider ?? "").Trim().ToLowerInvariant();
        var warning = p == "gemini"
            ? "Gemini does not expose pricing via its API; prices are shown for OpenRouter only."
            : null;
        try
        {
            var models = await _failover.RunAsync(p, (prov, key) => prov.ListModelsAsync(key, HttpContext.RequestAborted));
            return Ok(new ModelsResult(p, models, warning));
        }
        catch (AllKeysFailedException ex)
        {
            return Ok(new ModelsResult(p, Array.Empty<AiModelInfo>(),
                "Could not load models — " + string.Join(" ", ex.Errors)));
        }
        catch (AiProviderException ex)
        {
            return Ok(new ModelsResult(p, Array.Empty<AiModelInfo>(), "Could not load models — " + ex.Message));
        }
    }

    [HttpGet("config")]
    public async Task<ActionResult<ChatConfigDto>> GetConfig()
    {
        var c = await _db.ChatConfigs.AsNoTracking().FirstOrDefaultAsync();
        return Ok(new ChatConfigDto(c?.SelectedProvider, c?.GeminiModel, c?.OpenRouterModel));
    }

    [HttpPut("config")]
    public async Task<ActionResult<ChatConfigDto>> PutConfig([FromBody] ChatConfigInput input)
    {
        var c = await _db.ChatConfigs.FirstOrDefaultAsync();
        var existing = c is not null;
        c ??= new ChatConfig();
        c.SelectedProvider = input.SelectedProvider;
        c.GeminiModel = input.GeminiModel;
        c.OpenRouterModel = input.OpenRouterModel;
        c.UpdatedAt = DateTimeOffset.UtcNow;
        if (!existing) _db.ChatConfigs.Add(c);
        await _db.SaveChangesAsync();
        return Ok(new ChatConfigDto(c.SelectedProvider, c.GeminiModel, c.OpenRouterModel));
    }

    /// <summary>One agent turn. Read tools auto-run; a write tool returns a confirmation proposal.</summary>
    [HttpPost("chat")]
    public async Task<ActionResult<ChatTurnResponse>> Chat([FromBody] ChatTurnRequest req)
        => Ok(await _agent.RunAsync(req.Provider, req.Model, req.Messages ?? new(), HttpContext.RequestAborted));

    /// <summary>Execute an approved write action (re-validated server-side), then continue the turn.</summary>
    [HttpPost("chat/confirm")]
    public async Task<ActionResult<ChatTurnResponse>> Confirm([FromBody] ConfirmActionRequest req)
        => Ok(await _agent.ConfirmAsync(req, HttpContext.RequestAborted));
}
