using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Evervault.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddGmail : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "GmailConnections",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    EndUserId = table.Column<int>(type: "integer", nullable: false),
                    AccessTokenEncrypted = table.Column<string>(type: "text", nullable: false),
                    RefreshTokenEncrypted = table.Column<string>(type: "text", nullable: false),
                    AccessTokenExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    GmailEmail = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: true),
                    GmailSub = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    GrantedScopes = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    ConnectedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    PendingState = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    PendingCodeVerifier = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                    PendingCreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastHistoryId = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    LastSyncAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastSyncError = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    InitialSyncDone = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GmailConnections", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "GmailMessages",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    EndUserId = table.Column<int>(type: "integer", nullable: false),
                    GmailId = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ThreadId = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    FromAddr = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: false),
                    FromName = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    ToAddr = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: false),
                    Subject = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Snippet = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    BodyText = table.Column<string>(type: "text", nullable: false),
                    InternalDate = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    IsUnread = table.Column<bool>(type: "boolean", nullable: false),
                    IsImportant = table.Column<bool>(type: "boolean", nullable: false),
                    IsStarred = table.Column<bool>(type: "boolean", nullable: false),
                    Category = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    SyncedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GmailMessages", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_GmailConnections_EndUserId",
                table: "GmailConnections",
                column: "EndUserId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GmailMessages_EndUserId_GmailId",
                table: "GmailMessages",
                columns: new[] { "EndUserId", "GmailId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GmailMessages_EndUserId_InternalDate",
                table: "GmailMessages",
                columns: new[] { "EndUserId", "InternalDate" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GmailConnections");

            migrationBuilder.DropTable(
                name: "GmailMessages");
        }
    }
}
