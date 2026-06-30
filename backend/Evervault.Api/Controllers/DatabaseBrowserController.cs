using System.Data.Common;
using Evervault.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// Read-only browser over the application's database tables. Generic by design — it reads the
/// Postgres catalog rather than the EF model, so it stays correct as the schema evolves.
/// Two safeguards keep it from leaking key material: the Data Protection key table (which holds
/// the unencrypted master keys backing every "encrypted" secret and the auth cookies) is hidden
/// entirely, and secret/hash columns are masked server-side. Everything else is shown as its
/// stored text form; nothing is decrypted.
/// </summary>
[ApiController]
[Route("admin/database")]
[Authorize] // default scheme = AdminController.Scheme ("AdminCookie")
public class DatabaseBrowserController : ControllerBase
{
    private readonly AppDbContext _db;
    public DatabaseBrowserController(AppDbContext db) => _db = db;

    // Cap cell text so huge values (embedding vectors, hashes, ciphertext) don't bloat responses.
    private const int MaxCellLength = 500;

    // Infra tables that must never be browseable. DataProtectionKeys stores the cleartext master
    // keys (no ProtectKeysWith* is configured) that decrypt every secret column and sign the auth
    // cookies, so exposing it would defeat encryption-at-rest entirely.
    private static readonly HashSet<string> HiddenTables = new(StringComparer.Ordinal)
    {
        "DataProtectionKeys",
    };

    // Sensitive columns are masked rather than echoed back, mirroring the rest of the app where
    // these are never returned to clients. Suffix-based so it stays correct as the schema grows.
    private static bool IsSensitiveColumn(string name) =>
        name == "PasswordHash" || name.EndsWith("Encrypted", StringComparison.Ordinal);

    public record TableInfo(string Name, long Rows);
    public record ColumnInfo(string Name, string Type);
    public record TablePage(
        string Name,
        IReadOnlyList<ColumnInfo> Columns,
        IReadOnlyList<string?[]> Rows,
        long Total,
        int Skip,
        int Take);

    /// <summary>All base tables in the public schema with estimated row counts (catalog-only, no scan).</summary>
    [HttpGet("tables")]
    public async Task<ActionResult<object>> Tables()
    {
        await _db.Database.OpenConnectionAsync();
        try
        {
            return Ok(new { tables = await ListTablesAsync() });
        }
        finally
        {
            await _db.Database.CloseConnectionAsync();
        }
    }

    /// <summary>One page of a table's rows, ordered for stable pagination. Read-only.</summary>
    [HttpGet("tables/{name}")]
    public async Task<ActionResult<TablePage>> Rows(string name, int skip = 0, int take = 50)
    {
        await _db.Database.OpenConnectionAsync();
        try
        {
            // Whitelist the identifier against the live catalog — the only value we ever interpolate
            // into SQL. Anything not confirmed by the catalog is rejected, so there is no injection path.
            var known = (await ListTablesAsync()).Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
            if (!known.Contains(name))
                return NotFound(new { error = $"Unknown table '{name}'." });

            skip = Math.Max(0, skip);
            take = Math.Clamp(take, 1, 100);

            var columns = await ListColumnsAsync(name);
            var tableSql = Quote(name);

            var total = await ScalarLongAsync($"SELECT COUNT(*) FROM {tableSql}");

            var rows = new List<string?[]>();
            if (columns.Count > 0)
            {
                // Cast each column to text in SQL so every value comes back as string/NULL regardless of
                // type (vector, bytea, jsonb, timestamp, …), keeping the reader and the response uniform.
                // ORDER BY ctid is available on any heap table and avoids type-ordering issues (e.g. a
                // vector first column has no ordering operator); good enough for a read-only viewer.
                var sensitive = columns.Select(c => IsSensitiveColumn(c.Name)).ToArray();
                var selectList = string.Join(", ", columns.Select(c => $"{Quote(c.Name)}::text"));
                var sql = $"SELECT {selectList} FROM {tableSql} ORDER BY ctid OFFSET @skip LIMIT @take";

                await using var cmd = _db.Database.GetDbConnection().CreateCommand();
                cmd.CommandText = sql;
                AddParam(cmd, "@skip", skip);
                AddParam(cmd, "@take", take);

                await using var reader = await cmd.ExecuteReaderAsync();
                while (await reader.ReadAsync())
                {
                    var row = new string?[columns.Count];
                    for (var i = 0; i < columns.Count; i++)
                        row[i] = reader.IsDBNull(i) ? null
                            : sensitive[i] ? "(hidden)"
                            : Truncate(reader.GetString(i));
                    rows.Add(row);
                }
            }

            return Ok(new TablePage(name, columns, rows, total, skip, take));
        }
        finally
        {
            await _db.Database.CloseConnectionAsync();
        }
    }

    // --- helpers (assume the connection is already open) ---

    private async Task<List<TableInfo>> ListTablesAsync()
    {
        const string sql = """
            SELECT relname AS name, GREATEST(reltuples, 0)::bigint AS rows
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
            ORDER BY relname
            """;
        var list = new List<TableInfo>();
        await using var cmd = _db.Database.GetDbConnection().CreateCommand();
        cmd.CommandText = sql;
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var name = reader.GetString(0);
            if (HiddenTables.Contains(name)) continue;
            list.Add(new TableInfo(name, reader.GetInt64(1)));
        }
        return list;
    }

    private async Task<List<ColumnInfo>> ListColumnsAsync(string table)
    {
        // pg_attribute + format_type yields the real, human-readable type (e.g. "vector(1536)",
        // "timestamp with time zone", "jsonb") — information_schema.data_type reports the unhelpful
        // "USER-DEFINED" for extension types like pgvector and "ARRAY" for arrays.
        const string sql = """
            SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = @t
              AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
            """;
        var list = new List<ColumnInfo>();
        await using var cmd = _db.Database.GetDbConnection().CreateCommand();
        cmd.CommandText = sql;
        AddParam(cmd, "@t", table);
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            list.Add(new ColumnInfo(reader.GetString(0), reader.GetString(1)));
        return list;
    }

    private async Task<long> ScalarLongAsync(string sql)
    {
        await using var cmd = _db.Database.GetDbConnection().CreateCommand();
        cmd.CommandText = sql;
        var result = await cmd.ExecuteScalarAsync();
        return result is null or DBNull ? 0 : Convert.ToInt64(result);
    }

    private static void AddParam(DbCommand cmd, string name, object value)
    {
        var p = cmd.CreateParameter();
        p.ParameterName = name;
        p.Value = value;
        cmd.Parameters.Add(p);
    }

    // Double-quote a Postgres identifier, escaping any embedded quote. Combined with the catalog
    // whitelist above, this makes table/column names safe to interpolate.
    private static string Quote(string identifier) => "\"" + identifier.Replace("\"", "\"\"") + "\"";

    private static string Truncate(string s) => s.Length <= MaxCellLength ? s : s[..MaxCellLength] + "…";
}
