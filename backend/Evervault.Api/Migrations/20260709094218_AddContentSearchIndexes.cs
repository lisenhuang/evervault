using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddContentSearchIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AlterDatabase()
                .Annotation("Npgsql:PostgresExtension:pg_trgm", ",,")
                .Annotation("Npgsql:PostgresExtension:vector", ",,")
                .OldAnnotation("Npgsql:PostgresExtension:vector", ",,");

            // Hybrid keyword search on ChatMemories.Content. These are expression indexes, which EF
            // doesn't model in the snapshot — raw SQL is the honest way to add them.
            //   - trigram GIN: fuzzy substring + CJK matching (word_similarity), also speeds the ILIKE fallback.
            //   - simple-config tsvector GIN: ranked full-text for space-delimited languages (websearch_to_tsquery).
            // IF NOT EXISTS keeps this idempotent/safe if re-run.
            migrationBuilder.Sql(
                "CREATE INDEX IF NOT EXISTS \"IX_ChatMemories_Content_trgm\" ON \"ChatMemories\" USING gin (\"Content\" gin_trgm_ops);");
            migrationBuilder.Sql(
                "CREATE INDEX IF NOT EXISTS \"IX_ChatMemories_Content_tsv\" ON \"ChatMemories\" USING gin (to_tsvector('simple', \"Content\"));");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP INDEX IF EXISTS \"IX_ChatMemories_Content_tsv\";");
            migrationBuilder.Sql("DROP INDEX IF EXISTS \"IX_ChatMemories_Content_trgm\";");

            migrationBuilder.AlterDatabase()
                .Annotation("Npgsql:PostgresExtension:vector", ",,")
                .OldAnnotation("Npgsql:PostgresExtension:pg_trgm", ",,")
                .OldAnnotation("Npgsql:PostgresExtension:vector", ",,");
        }
    }
}
