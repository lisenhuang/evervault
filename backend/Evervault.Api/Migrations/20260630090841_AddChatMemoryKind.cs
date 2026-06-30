using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddChatMemoryKind : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Kind",
                table: "ChatMemories",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValue: "turn");

            migrationBuilder.CreateIndex(
                name: "IX_ChatMemories_EndUserId_Kind",
                table: "ChatMemories",
                columns: new[] { "EndUserId", "Kind" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ChatMemories_EndUserId_Kind",
                table: "ChatMemories");

            migrationBuilder.DropColumn(
                name: "Kind",
                table: "ChatMemories");
        }
    }
}
