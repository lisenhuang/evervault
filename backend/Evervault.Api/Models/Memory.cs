using Pgvector;

namespace Evervault.Api.Models;

/// <summary>A stored memory plus its embedding (for semantic search).</summary>
public class Memory
{
    public int Id { get; set; }
    public string Content { get; set; } = string.Empty;
    public Vector Embedding { get; set; } = null!;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
