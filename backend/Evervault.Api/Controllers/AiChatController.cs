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
    public record ChatConfigDto(string? SelectedProvider, string? GeminiModel, string? OpenRouterModel, string? OpenAiModel, string? ReasoningEffort, string? OpenAiReasoning);
    public record ChatConfigInput(string? SelectedProvider, string? GeminiModel, string? OpenRouterModel, string? OpenAiModel, string? ReasoningEffort, string? OpenAiReasoning);
    public record EmbeddingConfigDto(string Provider, string? Model, int Dimensions, bool Locked, DateTimeOffset? LockedAt);
    public record EmbeddingConfigInput(string? Model, int Dimensions);

    /// <summary>Live model list for a provider (free/paid + pricing where exposed). Goes through failover.
    /// <paramref name="kind"/> = "chat" (default) or "embedding".</summary>
    [HttpGet("models")]
    public async Task<ActionResult<ModelsResult>> Models([FromQuery] string provider, [FromQuery] string? kind)
    {
        var p = (provider ?? "").Trim().ToLowerInvariant();
        var k = string.IsNullOrWhiteSpace(kind) ? "chat" : kind.Trim().ToLowerInvariant();
        var warning = p == "gemini"
            ? "Gemini does not expose pricing via its API; prices are shown for OpenRouter only."
            : null;
        try
        {
            var models = await _failover.RunAsync(p, (prov, key) => prov.ListModelsAsync(key, k, HttpContext.RequestAborted));
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

    /// <summary>Credit/quota usage for the provider's key (OpenRouter exposes this; Gemini does not).</summary>
    [HttpGet("usage")]
    public async Task<ActionResult<AiKeyUsage>> Usage([FromQuery] string provider)
    {
        var p = (provider ?? "").Trim().ToLowerInvariant();
        try
        {
            var usage = await _failover.RunAsync(p, (prov, key) => prov.GetUsageAsync(key, HttpContext.RequestAborted));
            return Ok(usage);
        }
        catch (Exception)
        {
            return Ok(new AiKeyUsage(false, null, null, null, null, null, null, null));
        }
    }

    [HttpGet("config")]
    public async Task<ActionResult<ChatConfigDto>> GetConfig()
    {
        var c = await _db.ChatConfigs.AsNoTracking().FirstOrDefaultAsync();
        return Ok(new ChatConfigDto(c?.SelectedProvider, c?.GeminiModel, c?.OpenRouterModel, c?.OpenAiModel, c?.ReasoningEffort, c?.OpenAiReasoning));
    }

    [HttpPut("config")]
    public async Task<ActionResult<ChatConfigDto>> PutConfig([FromBody] ChatConfigInput input)
    {
        var c = await _db.ChatConfigs.FirstOrDefaultAsync();
        var existing = c is not null;
        c ??= new ChatConfig();
        // Merge: only overwrite fields the caller actually sent (non-null), so the settings page
        // (reasoning effort) and the chat model-switcher (provider/model) don't clobber each other.
        if (input.SelectedProvider is not null) c.SelectedProvider = input.SelectedProvider;
        if (input.GeminiModel is not null) c.GeminiModel = input.GeminiModel;
        if (input.OpenRouterModel is not null) c.OpenRouterModel = input.OpenRouterModel;
        if (input.OpenAiModel is not null) c.OpenAiModel = input.OpenAiModel;
        if (input.ReasoningEffort is not null) c.ReasoningEffort = input.ReasoningEffort;
        if (input.OpenAiReasoning is not null) c.OpenAiReasoning = input.OpenAiReasoning;
        c.UpdatedAt = DateTimeOffset.UtcNow;
        if (!existing) _db.ChatConfigs.Add(c);
        await _db.SaveChangesAsync();
        return Ok(new ChatConfigDto(c.SelectedProvider, c.GeminiModel, c.OpenRouterModel, c.OpenAiModel, c.ReasoningEffort, c.OpenAiReasoning));
    }

    /// <summary>The chat-memory embedding policy (model + dimension). Chosen once, then immutable.</summary>
    [HttpGet("embedding-config")]
    public async Task<ActionResult<EmbeddingConfigDto>> GetEmbeddingConfig()
    {
        var c = await _db.EmbeddingConfigs.AsNoTracking().FirstOrDefaultAsync();
        if (c is null) return Ok(new EmbeddingConfigDto("gemini", null, 1536, false, null));
        return Ok(new EmbeddingConfigDto(c.Provider, c.Model, c.Dimensions, c.LockedAt is not null, c.LockedAt));
    }

    /// <summary>Set the embedding model + dimension. 409 once locked — it can never change (it would
    /// invalidate every stored vector).</summary>
    [HttpPut("embedding-config")]
    public async Task<ActionResult<EmbeddingConfigDto>> PutEmbeddingConfig([FromBody] EmbeddingConfigInput input)
    {
        var c = await _db.EmbeddingConfigs.FirstOrDefaultAsync();
        if (c is { LockedAt: not null })
            return Conflict(new { error = "The embedding model and dimension are locked and cannot be changed." });
        if (string.IsNullOrWhiteSpace(input.Model))
            return BadRequest(new { error = "Choose an embedding model." });
        if (input.Dimensions is not (768 or 1536 or 3072))
            return BadRequest(new { error = "Dimension must be 768, 1536, or 3072." });

        var existing = c is not null;
        c ??= new EmbeddingConfig();
        c.Provider = "gemini";
        c.Model = input.Model.Trim();
        c.Dimensions = input.Dimensions;
        c.LockedAt = DateTimeOffset.UtcNow;
        c.UpdatedAt = DateTimeOffset.UtcNow;
        if (!existing) _db.EmbeddingConfigs.Add(c);
        await _db.SaveChangesAsync();
        return Ok(new EmbeddingConfigDto(c.Provider, c.Model, c.Dimensions, true, c.LockedAt));
    }

    /// <summary>One agent turn. Read tools auto-run; a write tool returns a confirmation proposal.</summary>
    [HttpPost("chat")]
    public async Task<ActionResult<ChatTurnResponse>> Chat([FromBody] ChatTurnRequest req)
        => Ok(await _agent.RunAsync(req.Provider, req.Model, req.Messages ?? new(), await LoadGenOptionsAsync(req.Provider), HttpContext.RequestAborted));

    /// <summary>Execute an approved write action (re-validated server-side), then continue the turn.</summary>
    [HttpPost("chat/confirm")]
    public async Task<ActionResult<ChatTurnResponse>> Confirm([FromBody] ConfirmActionRequest req)
        => Ok(await _agent.ConfirmAsync(req, await LoadGenOptionsAsync(req.Provider), HttpContext.RequestAborted));

    /// <summary>Read the persisted reasoning effort for this turn. ChatGPT uses its own setting (its models
    /// advertise a distinct level set); the others share <c>ReasoningEffort</c>. Server-side so it can't be
    /// spoofed by the client.</summary>
    private async Task<AiGenerationOptions> LoadGenOptionsAsync(string? provider)
    {
        var c = await _db.ChatConfigs.AsNoTracking().FirstOrDefaultAsync();
        var effort = (provider ?? "").Trim().ToLowerInvariant() == "openai" ? c?.OpenAiReasoning : c?.ReasoningEffort;
        return new AiGenerationOptions(effort);
    }
}
