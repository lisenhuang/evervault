using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddWebappTextModelFailover : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Additive only: new nullable columns describing the /webapp text model's provider (Gemini or
            // ChatGPT), its reasoning level, and an optional fallback model. Existing rows keep TextModel as
            // the (Gemini) primary; a null TextProvider is treated as "gemini", so the deployed version reads
            // and writes these rows unchanged.
            migrationBuilder.AddColumn<string>(
                name: "TextProvider",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TextReasoning",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TextFallbackProvider",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TextFallbackModel",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TextFallbackReasoning",
                table: "WebappAiConfigs",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "TextProvider", table: "WebappAiConfigs");
            migrationBuilder.DropColumn(name: "TextReasoning", table: "WebappAiConfigs");
            migrationBuilder.DropColumn(name: "TextFallbackProvider", table: "WebappAiConfigs");
            migrationBuilder.DropColumn(name: "TextFallbackModel", table: "WebappAiConfigs");
            migrationBuilder.DropColumn(name: "TextFallbackReasoning", table: "WebappAiConfigs");
        }
    }
}
