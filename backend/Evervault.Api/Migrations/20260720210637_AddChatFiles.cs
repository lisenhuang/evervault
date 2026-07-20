using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;
using Pgvector;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddChatFiles : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ChatFiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    EndUserId = table.Column<int>(type: "integer", nullable: false),
                    ConversationId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    FileName = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    Kind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Mime = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    ObjectKey = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    Sha256 = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Description = table.Column<string>(type: "text", nullable: false),
                    EmbeddingHalf = table.Column<HalfVector>(type: "halfvec", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChatFiles", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ChatFiles_EndUserId",
                table: "ChatFiles",
                column: "EndUserId");

            migrationBuilder.CreateIndex(
                name: "IX_ChatFiles_EndUserId_CreatedAt",
                table: "ChatFiles",
                columns: new[] { "EndUserId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ChatFiles_EndUserId_Sha256",
                table: "ChatFiles",
                columns: new[] { "EndUserId", "Sha256" });

            // Hybrid keyword search on ChatFiles.Description (and FileName, which the trigram lane also
            // matches so a file can be found by name). These are expression indexes, which EF doesn't model
            // in the snapshot — raw SQL is the honest way to add them.
            //   - trigram GIN: fuzzy substring + CJK matching (word_similarity), also speeds the ILIKE fallback.
            //   - simple-config tsvector GIN: ranked full-text for space-delimited languages (websearch_to_tsquery).
            // The HNSW index on EmbeddingHalf is deliberately NOT here: its dimension is only known once the
            // admin locks it at runtime, so ChatMemoryVectorIndex builds it on startup instead.
            // IF NOT EXISTS keeps this idempotent/safe if re-run.
            migrationBuilder.Sql(
                "CREATE INDEX IF NOT EXISTS \"IX_ChatFiles_Description_trgm\" ON \"ChatFiles\" USING gin (\"Description\" gin_trgm_ops);");
            migrationBuilder.Sql(
                "CREATE INDEX IF NOT EXISTS \"IX_ChatFiles_Description_tsv\" ON \"ChatFiles\" USING gin (to_tsvector('simple', \"Description\"));");
            migrationBuilder.Sql(
                "CREATE INDEX IF NOT EXISTS \"IX_ChatFiles_FileName_trgm\" ON \"ChatFiles\" USING gin (\"FileName\" gin_trgm_ops);");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ChatFiles");
        }
    }
}
