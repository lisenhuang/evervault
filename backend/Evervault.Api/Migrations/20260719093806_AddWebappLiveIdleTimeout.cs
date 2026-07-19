using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddWebappLiveIdleTimeout : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Additive only: one nullable column holding the admin's auto-hang-up window for an idle live
            // voice call, in seconds (0 = never hang up). Null on every existing row, which the accessor
            // reads as the previous hard-coded 60s — so the deployed version is unaffected and behavior is
            // unchanged until an admin sets a value.
            migrationBuilder.AddColumn<int>(
                name: "LiveIdleTimeoutSeconds",
                table: "WebappAiConfigs",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LiveIdleTimeoutSeconds",
                table: "WebappAiConfigs");
        }
    }
}
