using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddAiCallLogs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AiCallLogs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Area = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Model = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    KeyHint = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    Outcome = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ErrorKind = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    ErrorMessage = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    HttpStatus = table.Column<int>(type: "integer", nullable: true),
                    PromptTokens = table.Column<int>(type: "integer", nullable: true),
                    CompletionTokens = table.Column<int>(type: "integer", nullable: true),
                    TotalTokens = table.Column<int>(type: "integer", nullable: true),
                    DurationMs = table.Column<int>(type: "integer", nullable: true),
                    EndUserId = table.Column<int>(type: "integer", nullable: true),
                    Detail = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AiCallLogs", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AiCallLogs_CreatedAt",
                table: "AiCallLogs",
                column: "CreatedAt");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AiCallLogs");
        }
    }
}
