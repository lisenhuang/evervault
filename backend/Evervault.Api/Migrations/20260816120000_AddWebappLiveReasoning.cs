using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddWebappLiveReasoning : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Additive only: two nullable columns holding the admin's thinking level ("minimal" | "low" |
            // "medium" | "high") for each Gemini Live leg — the realtime call and the voice-message reply.
            // Null on every existing row, and null means "send no thinkingConfig", i.e. exactly the behavior
            // shipped today (the Live model's own default, which is minimal). So the currently-deployed
            // version is unaffected and no call changes until an admin picks a level.
            migrationBuilder.AddColumn<string>(
                name: "LiveReasoning",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "VoiceLiveReasoning",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LiveReasoning",
                table: "WebappAiConfigs");

            migrationBuilder.DropColumn(
                name: "VoiceLiveReasoning",
                table: "WebappAiConfigs");
        }
    }
}
