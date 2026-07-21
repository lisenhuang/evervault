using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddWebappChunkVoiceReply : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Additive only: one nullable column that turns on sentence-chunked, streamed voice-reply
            // synthesis. Null on every existing row, which the accessor reads as false — so the deployed
            // version is unaffected and behavior is unchanged until an admin opts in.
            migrationBuilder.AddColumn<bool>(
                name: "ChunkVoiceReplyBySentence",
                table: "WebappAiConfigs",
                type: "boolean",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ChunkVoiceReplyBySentence",
                table: "WebappAiConfigs");
        }
    }
}
