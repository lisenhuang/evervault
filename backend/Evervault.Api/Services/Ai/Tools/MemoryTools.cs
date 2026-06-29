using System.Text.Json;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.EntityFrameworkCore;
using Pgvector;
using Pgvector.EntityFrameworkCore;

namespace Evervault.Api.Services.Ai.Tools;

// ---- Read tools ----

public class ListMemoriesTool : IAiTool
{
    private readonly AppDbContext _db;
    public ListMemoriesTool(AppDbContext db) => _db = db;

    public string Name => "list_memories";
    public string Description => "List the most recent memories (id, content, createdAt).";
    public string ParametersJson => """
    {"type":"object","properties":{"limit":{"type":"integer","description":"Max rows (default 20, max 100)."}}}
    """;
    public AiToolKind Kind => AiToolKind.Read;

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var limit = Math.Clamp(Args.Int(args, "limit") ?? 20, 1, 100);
        var rows = await _db.Memories.AsNoTracking()
            .OrderByDescending(m => m.CreatedAt)
            .Take(limit)
            .Select(m => new { m.Id, m.Content, m.CreatedAt })
            .ToListAsync(ct);
        return JsonSerializer.Serialize(rows);
    }
}

public class GetMemoryTool : IAiTool
{
    private readonly AppDbContext _db;
    public GetMemoryTool(AppDbContext db) => _db = db;

    public string Name => "get_memory";
    public string Description => "Get one memory by id.";
    public string ParametersJson => """
    {"type":"object","properties":{"id":{"type":"integer"}},"required":["id"]}
    """;
    public AiToolKind Kind => AiToolKind.Read;

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var id = Args.Int(args, "id");
        if (id is null) return "Error: 'id' is required.";
        var m = await _db.Memories.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct);
        return m is null ? $"No memory with id {id}." : JsonSerializer.Serialize(new { m.Id, m.Content, m.CreatedAt });
    }
}

public class SearchMemoriesTool : IAiTool
{
    private readonly AppDbContext _db;
    private readonly IEmbedder _embedder;
    public SearchMemoriesTool(AppDbContext db, IEmbedder embedder) { _db = db; _embedder = embedder; }

    public string Name => "search_memories";
    public string Description => "Semantic search over memories. Returns the closest matches.";
    public string ParametersJson => """
    {"type":"object","properties":{"query":{"type":"string"},"k":{"type":"integer","description":"How many results (default 5, max 50)."}},"required":["query"]}
    """;
    public AiToolKind Kind => AiToolKind.Read;

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var query = Args.Str(args, "query");
        if (string.IsNullOrWhiteSpace(query)) return "Error: 'query' is required.";
        var k = Math.Clamp(Args.Int(args, "k") ?? 5, 1, 50);
        var qv = new Vector(_embedder.Embed(query));
        var hits = await _db.Memories.AsNoTracking()
            .OrderBy(m => m.Embedding.CosineDistance(qv))
            .Take(k)
            .Select(m => new { m.Id, m.Content, Distance = m.Embedding.CosineDistance(qv) })
            .ToListAsync(ct);
        return JsonSerializer.Serialize(hits);
    }
}

public class DbStatsTool : IAiTool
{
    private readonly AppDbContext _db;
    public DbStatsTool(AppDbContext db) => _db = db;

    public string Name => "db_stats";
    public string Description => "Counts of the main entities (memories, admins, AI keys).";
    public string ParametersJson => """{"type":"object","properties":{}}""";
    public AiToolKind Kind => AiToolKind.Read;

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var stats = new
        {
            memories = await _db.Memories.CountAsync(ct),
            admins = await _db.Admins.CountAsync(ct),
            aiKeys = await _db.AiKeys.CountAsync(ct),
            storageConfigured = await _db.StorageConfigs.AnyAsync(ct),
        };
        return JsonSerializer.Serialize(stats);
    }
}

// ---- Write tools ----

public class CreateMemoryTool : IAiTool
{
    private readonly AppDbContext _db;
    private readonly IEmbedder _embedder;
    public CreateMemoryTool(AppDbContext db, IEmbedder embedder) { _db = db; _embedder = embedder; }

    public string Name => "create_memory";
    public string Description => "Create a new memory.";
    public string ParametersJson => """
    {"type":"object","properties":{"content":{"type":"string"},"change_summary":{"type":"string","description":"Exactly what will change, for the human to read."},"dangerous":{"type":"boolean","description":"True if destructive/irreversible."}},"required":["content","change_summary"]}
    """;
    public AiToolKind Kind => AiToolKind.Write;

    public string Summarize(JsonElement args) => $"Create a memory: \"{Truncate(Args.Str(args, "content"))}\"";

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var content = Args.Str(args, "content");
        if (string.IsNullOrWhiteSpace(content)) return "Error: 'content' is required.";
        var m = new Memory { Content = content.Trim(), Embedding = new Vector(_embedder.Embed(content)) };
        _db.Memories.Add(m);
        await _db.SaveChangesAsync(ct);
        return $"Created memory #{m.Id}.";
    }

    private static string Truncate(string? s) => string.IsNullOrEmpty(s) ? "" : (s.Length > 60 ? s[..60] + "…" : s);
}

public class UpdateMemoryTool : IAiTool
{
    private readonly AppDbContext _db;
    private readonly IEmbedder _embedder;
    public UpdateMemoryTool(AppDbContext db, IEmbedder embedder) { _db = db; _embedder = embedder; }

    public string Name => "update_memory";
    public string Description => "Replace the content of an existing memory by id.";
    public string ParametersJson => """
    {"type":"object","properties":{"id":{"type":"integer"},"content":{"type":"string"},"change_summary":{"type":"string"},"dangerous":{"type":"boolean"}},"required":["id","content","change_summary"]}
    """;
    public AiToolKind Kind => AiToolKind.Write;

    public string Summarize(JsonElement args) => $"Update memory #{Args.Int(args, "id")}.";

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var id = Args.Int(args, "id");
        var content = Args.Str(args, "content");
        if (id is null || string.IsNullOrWhiteSpace(content)) return "Error: 'id' and 'content' are required.";
        var m = await _db.Memories.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (m is null) return $"No memory with id {id}.";
        m.Content = content.Trim();
        m.Embedding = new Vector(_embedder.Embed(content));
        await _db.SaveChangesAsync(ct);
        return $"Updated memory #{m.Id}.";
    }
}

public class DeleteMemoryTool : IAiTool
{
    private readonly AppDbContext _db;
    public DeleteMemoryTool(AppDbContext db) => _db = db;

    public string Name => "delete_memory";
    public string Description => "Delete a memory by id. Irreversible.";
    public string ParametersJson => """
    {"type":"object","properties":{"id":{"type":"integer"},"change_summary":{"type":"string"},"dangerous":{"type":"boolean"}},"required":["id","change_summary"]}
    """;
    public AiToolKind Kind => AiToolKind.Write;

    // A delete is destructive — always require the typed CONFIRM gate.
    public bool ForceDangerous(JsonElement args) => true;

    public string Summarize(JsonElement args) => $"Delete memory #{Args.Int(args, "id")} (irreversible).";

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var id = Args.Int(args, "id");
        if (id is null) return "Error: 'id' is required.";
        var m = await _db.Memories.FindAsync(new object?[] { id }, ct);
        if (m is null) return $"No memory with id {id}.";
        _db.Memories.Remove(m);
        await _db.SaveChangesAsync(ct);
        return $"Deleted memory #{id}.";
    }
}
