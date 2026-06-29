using Evervault.Api.Data;
using Evervault.Api.Models;
using Evervault.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Pgvector;
using Pgvector.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

[ApiController]
[Route("memories")]
public class MemoriesController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IEmbedder _embedder;

    public MemoriesController(AppDbContext db, IEmbedder embedder)
    {
        _db = db;
        _embedder = embedder;
    }

    public record CreateMemoryRequest(string Content);
    public record MemoryDto(int Id, string Content, DateTimeOffset CreatedAt);
    public record SearchHit(int Id, string Content, double Distance);

    [HttpGet]
    public async Task<IEnumerable<MemoryDto>> List() =>
        await _db.Memories
            .OrderByDescending(m => m.CreatedAt)
            .Select(m => new MemoryDto(m.Id, m.Content, m.CreatedAt))
            .ToListAsync();

    [HttpGet("search")]
    public async Task<IEnumerable<SearchHit>> Search([FromQuery] string q, [FromQuery] int k = 5)
    {
        if (string.IsNullOrWhiteSpace(q)) return [];
        var qv = new Vector(_embedder.Embed(q));
        return await _db.Memories
            .OrderBy(m => m.Embedding.CosineDistance(qv))
            .Take(Math.Clamp(k, 1, 50))
            .Select(m => new SearchHit(m.Id, m.Content, m.Embedding.CosineDistance(qv)))
            .ToListAsync();
    }

    [HttpPost]
    [Authorize]
    public async Task<ActionResult<MemoryDto>> Create(CreateMemoryRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Content)) return BadRequest(new { error = "Content is required." });

        var memory = new Memory
        {
            Content = req.Content.Trim(),
            Embedding = new Vector(_embedder.Embed(req.Content)),
        };
        _db.Memories.Add(memory);
        await _db.SaveChangesAsync();
        return Created($"/api/memories/{memory.Id}", new MemoryDto(memory.Id, memory.Content, memory.CreatedAt));
    }

    [HttpDelete("{id:int}")]
    [Authorize]
    public async Task<IActionResult> Delete(int id)
    {
        var memory = await _db.Memories.FindAsync(id);
        if (memory is null) return NotFound();
        _db.Memories.Remove(memory);
        await _db.SaveChangesAsync();
        return NoContent();
    }
}
