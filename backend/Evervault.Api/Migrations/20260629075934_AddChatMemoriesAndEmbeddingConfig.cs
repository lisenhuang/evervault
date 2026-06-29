using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;
using Pgvector;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddChatMemoriesAndEmbeddingConfig : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ChatMemories",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    EndUserId = table.Column<int>(type: "integer", nullable: false),
                    ConversationId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Role = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Modality = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Content = table.Column<string>(type: "text", nullable: false),
                    AudioObjectKey = table.Column<string>(type: "text", nullable: true),
                    Embedding = table.Column<Vector>(type: "vector", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChatMemories", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "EmbeddingConfigs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Provider = table.Column<string>(type: "text", nullable: false),
                    Model = table.Column<string>(type: "text", nullable: true),
                    Dimensions = table.Column<int>(type: "integer", nullable: false),
                    LockedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_EmbeddingConfigs", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ChatMemories_EndUserId",
                table: "ChatMemories",
                column: "EndUserId");

            migrationBuilder.CreateIndex(
                name: "IX_ChatMemories_EndUserId_ConversationId",
                table: "ChatMemories",
                columns: new[] { "EndUserId", "ConversationId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ChatMemories");

            migrationBuilder.DropTable(
                name: "EmbeddingConfigs");
        }
    }
}
