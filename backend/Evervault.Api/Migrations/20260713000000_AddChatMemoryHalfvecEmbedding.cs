using Microsoft.EntityFrameworkCore.Migrations;
using Pgvector;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddChatMemoryHalfvecEmbedding : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Additive, backward-compatible: the previously-deployed version keeps using the existing
            // full-precision "Embedding" (vector) column untouched. New code dual-writes both columns and
            // reads from "EmbeddingHalf". A later release drops "Embedding" (contract step).
            //
            // Half-precision embedding (~half the disk of vector, negligible recall loss). Dimensionless
            // here; the runtime step (ChatMemoryVectorIndex) pins it to the admin's locked dimension and
            // builds the HNSW cosine index — an HNSW index needs a fixed dimension, unknown at migrate time.
            migrationBuilder.AddColumn<HalfVector>(
                name: "EmbeddingHalf",
                table: "ChatMemories",
                type: "halfvec",
                nullable: true);

            // Backfill from any existing full-precision vectors so recall (which now reads EmbeddingHalf)
            // sees historical rows immediately.
            migrationBuilder.Sql(
                "UPDATE \"ChatMemories\" SET \"EmbeddingHalf\" = \"Embedding\"::halfvec WHERE \"Embedding\" IS NOT NULL;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP INDEX IF EXISTS \"IX_ChatMemories_EmbeddingHalf_hnsw\";");
            migrationBuilder.DropColumn(
                name: "EmbeddingHalf",
                table: "ChatMemories");
        }
    }
}
