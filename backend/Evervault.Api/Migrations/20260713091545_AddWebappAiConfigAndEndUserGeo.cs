using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddWebappAiConfigAndEndUserGeo : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "LastCity",
                table: "EndUsers",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastContinent",
                table: "EndUsers",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastCountry",
                table: "EndUsers",
                type: "character varying(8)",
                maxLength: 8,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastIp",
                table: "EndUsers",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "LastLatitude",
                table: "EndUsers",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "LastLongitude",
                table: "EndUsers",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastPostalCode",
                table: "EndUsers",
                type: "character varying(32)",
                maxLength: 32,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastRegion",
                table: "EndUsers",
                type: "character varying(128)",
                maxLength: 128,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LastTimezone",
                table: "EndUsers",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "WebappAiConfigs",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    TextModel = table.Column<string>(type: "text", nullable: true),
                    AudioModel = table.Column<string>(type: "text", nullable: true),
                    LiveModel = table.Column<string>(type: "text", nullable: true),
                    DefaultVoice = table.Column<string>(type: "text", nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_WebappAiConfigs", x => x.Id);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "WebappAiConfigs");

            migrationBuilder.DropColumn(
                name: "LastCity",
                table: "EndUsers");

            migrationBuilder.DropColumn(
                name: "LastContinent",
                table: "EndUsers");

            migrationBuilder.DropColumn(
                name: "LastCountry",
                table: "EndUsers");

            migrationBuilder.DropColumn(
                name: "LastIp",
                table: "EndUsers");

            migrationBuilder.DropColumn(
                name: "LastLatitude",
                table: "EndUsers");

            migrationBuilder.DropColumn(
                name: "LastLongitude",
                table: "EndUsers");

            migrationBuilder.DropColumn(
                name: "LastPostalCode",
                table: "EndUsers");

            migrationBuilder.DropColumn(
                name: "LastRegion",
                table: "EndUsers");

            migrationBuilder.DropColumn(
                name: "LastTimezone",
                table: "EndUsers");
        }
    }
}
