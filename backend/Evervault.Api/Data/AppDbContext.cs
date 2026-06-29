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
        });
    }
}
