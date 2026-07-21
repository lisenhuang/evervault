using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddWebappVoiceLiveMode : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Additive only: two nullable columns for the /webapp voice-message path — the Gemini Live model
            // used for voice chat (null = inherit the realtime-call LiveModel) and the answer mode ("live" |
            // "tts", null = "live"). Null on every existing row, which the accessors read as those defaults, so
            // the deployed version is unaffected and voice behavior is unchanged until an admin sets a value.
            migrationBuilder.AddColumn<string>(
                name: "VoiceLiveModel",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "VoiceMode",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "VoiceLiveModel",
                table: "WebappAiConfigs");

            migrationBuilder.DropColumn(
                name: "VoiceMode",
                table: "WebappAiConfigs");
        }
    }
}
