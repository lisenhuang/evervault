using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddChatFileMessageLink : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ClientMessageId",
                table: "ChatFiles",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_ChatFiles_EndUserId_ConversationId",
                table: "ChatFiles",
                columns: new[] { "EndUserId", "ConversationId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_ChatFiles_EndUserId_ConversationId",
                table: "ChatFiles");

            migrationBuilder.DropColumn(
                name: "ClientMessageId",
                table: "ChatFiles");
        }
    }
}
