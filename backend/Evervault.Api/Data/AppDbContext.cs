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
    public DbSet<WebappAiConfig> WebappAiConfigs => Set<WebappAiConfig>();
    public DbSet<GoogleAuthConfig> GoogleAuthConfigs => Set<GoogleAuthConfig>();
    public DbSet<BraveSearchConfig> BraveSearchConfigs => Set<BraveSearchConfig>();
    public DbSet<OpenAiOAuthConfig> OpenAiOAuthConfigs => Set<OpenAiOAuthConfig>();
    public DbSet<EndUser> EndUsers => Set<EndUser>();
    public DbSet<EmbeddingConfig> EmbeddingConfigs => Set<EmbeddingConfig>();
    public DbSet<ChatMemory> ChatMemories => Set<ChatMemory>();
    public DbSet<ChatTranscript> ChatTranscripts => Set<ChatTranscript>();
    public DbSet<ChatConversation> ChatConversations => Set<ChatConversation>();
    public DbSet<ChatFile> ChatFiles => Set<ChatFile>();
    public DbSet<UserMemoryFact> UserMemoryFacts => Set<UserMemoryFact>();
    public DbSet<UserTask> UserTasks => Set<UserTask>();
    public DbSet<UserState> UserStates => Set<UserState>();
    public DbSet<UserLifeEvent> UserLifeEvents => Set<UserLifeEvent>();
    public DbSet<ErrorReport> ErrorReports => Set<ErrorReport>();
    public DbSet<AiCallLog> AiCallLogs => Set<AiCallLog>();
    public DbSet<Suggestion> Suggestions => Set<Suggestion>();
    public DbSet<SuggestionImage> SuggestionImages => Set<SuggestionImage>();

    // Data Protection keys persisted here so cookies (and the encrypted R2 secret) survive
    // container restarts with zero configuration.
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.HasPostgresExtension("vector");
        // Trigram matching for the hybrid keyword search lane (fuzzy substring + CJK, where
        // whitespace-tokenized FTS can't segment). The GIN index is added in a migration.
        modelBuilder.HasPostgresExtension("pg_trgm");

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
            // Last-seen Cloudflare IP/geo (all nullable, additive).
            e.Property(u => u.LastIp).HasMaxLength(64);
            e.Property(u => u.LastCountry).HasMaxLength(8);
            e.Property(u => u.LastCity).HasMaxLength(128);
            e.Property(u => u.LastRegion).HasMaxLength(128);
            e.Property(u => u.LastContinent).HasMaxLength(32);
            e.Property(u => u.LastPostalCode).HasMaxLength(32);
            e.Property(u => u.LastTimezone).HasMaxLength(64);
            // Per-surface /webapp response-style prefs (nullable; null = "default"). Short enum-ish
            // strings, sized like the other 16-char enum columns (Role/Modality/Kind/Status).
            e.Property(u => u.TextStyle).HasMaxLength(16);
            e.Property(u => u.VoiceStyle).HasMaxLength(16);
            e.Property(u => u.LiveStyle).HasMaxLength(16);
        });

        modelBuilder.Entity<ChatMemory>(e =>
        {
            // Dimensionless vector: the admin picks the dimension at runtime, so we can't fix it here.
            // Legacy full-precision column, kept for rollout compatibility; searches use EmbeddingHalf.
            e.Property(m => m.Embedding).HasColumnType("vector");
            // Half-precision embedding (~half the disk). Dimensionless at the model level; a runtime step
            // (ChatMemoryVectorIndex) pins it to the locked dimension and builds the HNSW cosine index once
            // the admin has chosen the dimension — an HNSW index needs a fixed dimension, unknown here.
            e.Property(m => m.EmbeddingHalf).HasColumnType("halfvec");
            e.Property(m => m.Role).HasMaxLength(16);
            e.Property(m => m.Modality).HasMaxLength(16);
            e.Property(m => m.Kind).HasMaxLength(16).HasDefaultValue("turn");
            e.Property(m => m.ConversationId).HasMaxLength(64);
            e.HasIndex(m => m.EndUserId);
            e.HasIndex(m => new { m.EndUserId, m.ConversationId });
            e.HasIndex(m => new { m.EndUserId, m.Kind });
        });

        modelBuilder.Entity<ChatTranscript>(e =>
        {
            e.Property(t => t.ConversationId).HasMaxLength(64);
            e.Property(t => t.ClientMessageId).HasMaxLength(64);
            e.Property(t => t.Role).HasMaxLength(16);
            e.Property(t => t.Modality).HasMaxLength(16);
            // Content stays unbounded text with NO tsvector/trigram expression index — see ChatTranscript.
            // Idempotency anchor: re-recording the same browser message updates its row instead of
            // appending a duplicate, which is what makes the client's retry/unload flush safe.
            e.HasIndex(t => new { t.EndUserId, t.ClientMessageId }).IsUnique();
            // Read one conversation back in the order it was said.
            e.HasIndex(t => new { t.EndUserId, t.ConversationId, t.Id });
            // Newest-first listing across conversations.
            e.HasIndex(t => new { t.EndUserId, t.CreatedAt });
        });

        modelBuilder.Entity<ChatConversation>(e =>
        {
            e.Property(c => c.ConversationId).HasMaxLength(64);
            // Supersede anchor: one row of preferences per conversation, so setting a pin twice
            // updates it rather than stacking a second opinion.
            e.HasIndex(c => new { c.EndUserId, c.ConversationId }).IsUnique();
        });

        modelBuilder.Entity<ChatFile>(e =>
        {
            // Half-precision embedding of the file's Description. Dimensionless at the model level; the same
            // runtime step as ChatMemories (ChatMemoryVectorIndex) pins it to the locked dimension and builds
            // the HNSW cosine index — an HNSW index needs a fixed dimension, unknown here. No legacy
            // full-precision column: nothing was ever deployed reading one from this table.
            e.Property(f => f.EmbeddingHalf).HasColumnType("halfvec");
            e.Property(f => f.FileName).HasMaxLength(255);
            e.Property(f => f.Kind).HasMaxLength(16);
            e.Property(f => f.Mime).HasMaxLength(128);
            e.Property(f => f.ObjectKey).HasMaxLength(400);
            e.Property(f => f.Sha256).HasMaxLength(64);
            e.Property(f => f.ConversationId).HasMaxLength(64);
            // Description is unbounded (text) — it's the searchable body (transcript / summary), not a label.
            e.HasIndex(f => f.EndUserId);
            // Listing + the newest-first fallbacks in file search.
            e.HasIndex(f => new { f.EndUserId, f.CreatedAt });
            // Upload dedupe: same user re-sending the identical bytes under the same name.
            e.HasIndex(f => new { f.EndUserId, f.Sha256 });
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

        modelBuilder.Entity<UserLifeEvent>(e =>
        {
            e.Property(x => x.Title).HasMaxLength(200);
            e.Property(x => x.Details).HasMaxLength(1000);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.SourceConversationId).HasMaxLength(64);
            // Injection query path: this user's open events, soonest first.
            e.HasIndex(x => new { x.EndUserId, x.Status, x.EventDate });
        });

        modelBuilder.Entity<UserState>(e =>
        {
            e.Property(s => s.Key).HasMaxLength(40);
            e.Property(s => s.Value).HasMaxLength(500);
            e.HasIndex(s => s.EndUserId);
            // Supersede anchor: re-extracting the same theme updates the row instead of piling up.
            e.HasIndex(s => new { s.EndUserId, s.Key }).IsUnique();
        });

        modelBuilder.Entity<UserTask>(e =>
        {
            e.Property(t => t.Title).HasMaxLength(200);
            e.Property(t => t.Details).HasMaxLength(2000);
            e.Property(t => t.DueTime).HasMaxLength(5);
            e.Property(t => t.Status).HasMaxLength(16);
            e.Property(t => t.Source).HasMaxLength(16);
            e.Property(t => t.SourceConversationId).HasMaxLength(64);
            e.Property(t => t.Recurrence).HasMaxLength(64);
            // Agenda query path: open tasks for a user, ordered by due date.
            e.HasIndex(t => new { t.EndUserId, t.Status, t.DueDate });
        });

        modelBuilder.Entity<AiKey>(e =>
        {
            e.Property(k => k.Provider).HasMaxLength(32);
            // Failover query path: enabled keys for a provider, in order.
            e.HasIndex(k => new { k.Provider, k.Enabled, k.SortOrder });
        });

        modelBuilder.Entity<ErrorReport>(e =>
        {
            e.Property(r => r.Code).HasMaxLength(20);
            // The user-visible handle; unique so a client queue retry is an idempotent no-op.
            e.HasIndex(r => r.Code).IsUnique();
            e.Property(r => r.Source).HasMaxLength(16);
            e.Property(r => r.Area).HasMaxLength(40);
            e.Property(r => r.Message).HasMaxLength(2000);
            e.Property(r => r.Detail).HasMaxLength(8000);
            e.Property(r => r.UserAgent).HasMaxLength(400);
            // Admin listing (newest first) + the opportunistic retention sweep.
            e.HasIndex(r => r.CreatedAt);
        });

        modelBuilder.Entity<AiCallLog>(e =>
        {
            e.Property(r => r.Provider).HasMaxLength(32);
            e.Property(r => r.Area).HasMaxLength(32);
            e.Property(r => r.Model).HasMaxLength(128);
            e.Property(r => r.KeyHint).HasMaxLength(64);
            e.Property(r => r.Outcome).HasMaxLength(16);
            e.Property(r => r.ErrorKind).HasMaxLength(16);
            e.Property(r => r.ErrorMessage).HasMaxLength(2000);
            e.Property(r => r.Detail).HasMaxLength(4000);
            // Admin listing (newest first) + stats rollups + the opportunistic retention sweep.
            e.HasIndex(r => r.CreatedAt);
        });

        modelBuilder.Entity<Suggestion>(e =>
        {
            e.Property(s => s.UserEmail).HasMaxLength(320);
            e.Property(s => s.Category).HasMaxLength(24);
            e.Property(s => s.Summary).HasMaxLength(300);
            e.Property(s => s.Details).HasMaxLength(8000);
            e.Property(s => s.Status).HasMaxLength(16);
            e.Property(s => s.UserAgent).HasMaxLength(400);
            // Admin listing (newest first) + the per-status filter.
            e.HasIndex(s => s.CreatedAt);
            e.HasIndex(s => s.Status);
            // Images are cascade-deleted with their suggestion.
            e.HasMany(s => s.Images)
                .WithOne(i => i.Suggestion!)
                .HasForeignKey(i => i.SuggestionId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<SuggestionImage>(e =>
        {
            e.Property(i => i.ObjectKey).HasMaxLength(400);
            e.Property(i => i.Mime).HasMaxLength(64);
        });
    }
}
