using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddChatTranscripts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // The verbatim conversation record: one row per message, every surface (typed, voice, live
            // call). Purely additive — a new table nothing deployed reads or writes, so the currently
            // running version is unaffected.
            //
            // No tsvector/trigram expression index on Content, unlike ChatMemories/ChatFiles: those are
            // maintained on INSERT and a tsvector over ~1MB fails the write, which is why the memory
            // table clips at 16k. Recall keeps searching ChatMemories; this table only has to be faithful.
            migrationBuilder.CreateTable(
                name: "ChatTranscripts",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    EndUserId = table.Column<int>(type: "integer", nullable: false),
                    ConversationId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    ClientMessageId = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Role = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Modality = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Content = table.Column<string>(type: "text", nullable: false),
                    ClientCreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChatTranscripts", x => x.Id);
                });

            // Idempotency: the browser's message id. Recording is retried and re-sent as a reply settles,
            // so every write after the first has to update this row rather than append a duplicate.
            migrationBuilder.CreateIndex(
                name: "IX_ChatTranscripts_EndUserId_ClientMessageId",
                table: "ChatTranscripts",
                columns: new[] { "EndUserId", "ClientMessageId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ChatTranscripts_EndUserId_ConversationId_Id",
                table: "ChatTranscripts",
                columns: new[] { "EndUserId", "ConversationId", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_ChatTranscripts_EndUserId_CreatedAt",
                table: "ChatTranscripts",
                columns: new[] { "EndUserId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ChatTranscripts");
        }
    }
}
