using Evervault.Api.Models;
using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Data;

public class AppDbContext : DbContext, IDataProtectionKeyContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Memory> Memories => Set<Memory>();
    public DbSet<AdminUser> Admins => Set<AdminUser>();
    public DbSet<StorageConfig> StorageConfigs => Set<StorageConfig>();
    public DbSet<AiKey> AiKeys => Set<AiKey>();
    public DbSet<ChatConfig> ChatConfigs => Set<ChatConfig>();
    public DbSet<GoogleAuthConfig> GoogleAuthConfigs => Set<GoogleAuthConfig>();
    public DbSet<EndUser> EndUsers => Set<EndUser>();
    public DbSet<EmbeddingConfig> EmbeddingConfigs => Set<EmbeddingConfig>();
    public DbSet<ChatMemory> ChatMemories => Set<ChatMemory>();
    public DbSet<UserMemoryFact> UserMemoryFacts => Set<UserMemoryFact>();

    // Data Protection keys persisted here so cookies (and the encrypted R2 secret) survive
    // container restarts with zero configuration.
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.HasPostgresExtension("vector");

        modelBuilder.Entity<Memory>(e =>
        {
            e.Property(m => m.Embedding).HasColumnType("vector(1536)");
            e.HasIndex(m => m.Embedding)
                .HasMethod("hnsw")
                .HasOperators("vector_cosine_ops");
        });

        modelBuilder.Entity<AdminUser>(e =>
        {
            e.Property(a => a.Email).HasMaxLength(256);
            e.HasIndex(a => a.Email).IsUnique();
            e.Property(a => a.GoogleSub).HasMaxLength(64);
            // Filtered so multiple unbound admins (NULL GoogleSub) are allowed.
            e.HasIndex(a => a.GoogleSub).IsUnique().HasFilter("\"GoogleSub\" IS NOT NULL");
        });

        modelBuilder.Entity<EndUser>(e =>
        {
            e.Property(u => u.GoogleSub).HasMaxLength(64);
            e.HasIndex(u => u.GoogleSub).IsUnique();
            e.Property(u => u.Email).HasMaxLength(256);
        });

        modelBuilder.Entity<ChatMemory>(e =>
        {
            // Dimensionless vector: the admin picks the dimension at runtime, so we can't fix it here.
            // Searches are always scoped to one EndUserId (tiny candidate set), so exact cosine is fine.
            e.Property(m => m.Embedding).HasColumnType("vector");
            e.Property(m => m.Role).HasMaxLength(16);
            e.Property(m => m.Modality).HasMaxLength(16);
            e.Property(m => m.Kind).HasMaxLength(16).HasDefaultValue("turn");
            e.Property(m => m.ConversationId).HasMaxLength(64);
            e.HasIndex(m => m.EndUserId);
            e.HasIndex(m => new { m.EndUserId, m.ConversationId });
            e.HasIndex(m => new { m.EndUserId, m.Kind });
        });

        modelBuilder.Entity<UserMemoryFact>(e =>
        {
            e.Property(f => f.Category).HasMaxLength(32);
            e.Property(f => f.Key).HasMaxLength(80);
            e.Property(f => f.Value).HasMaxLength(2000);
            e.Property(f => f.Source).HasMaxLength(16);
            e.HasIndex(f => f.EndUserId);
            // Supersede anchor: re-extracting the same (user, category, key) updates the row in place.
            e.HasIndex(f => new { f.EndUserId, f.Category, f.Key }).IsUnique();
        });

        modelBuilder.Entity<AiKey>(e =>
        {
            e.Property(k => k.Provider).HasMaxLength(32);
            // Failover query path: enabled keys for a provider, in order.
            e.HasIndex(k => new { k.Provider, k.Enabled, k.SortOrder });
        });
    }
}
