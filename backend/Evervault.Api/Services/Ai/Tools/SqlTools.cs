using System.Text;
using System.Text.Json;
using Evervault.Api.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Evervault.Api.Services.Ai.Tools;

/// <summary>Read-only SQL. Auto-runs (no confirmation) but is locked down: single SELECT/WITH statement,
/// executed in a READ ONLY transaction with a short statement timeout and a row cap, and references to
/// secret-bearing tables/columns are blocked so encrypted keys/secrets never reach the LLM.</summary>
public class SqlQueryTool : IAiTool
{
    private const int MaxRows = 200;
    private static readonly string[] Denied =
        { "dataprotectionkeys", "passwordhash", "secretencrypted", "keyencrypted" };

    private readonly string _connectionString;
    public SqlQueryTool(IConfiguration config)
        => _connectionString = config.GetConnectionString("Default") ?? "";

    public string Name => "sql_query";
    public string Description =>
        "Run a read-only SQL query (single SELECT/WITH statement) against the Postgres database and return the rows. " +
        "Use this for any data lookups. Tables are PascalCase and quoted, e.g. SELECT * FROM \"Memories\".";
    public string ParametersJson => """
    {"type":"object","properties":{"sql":{"type":"string","description":"A single read-only SELECT/WITH statement."}},"required":["sql"]}
    """;
    public AiToolKind Kind => AiToolKind.Read;

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var sql = (Args.Str(args, "sql") ?? "").Trim();
        var error = Validate(sql);
        if (error is not null) return "Error: " + error;

        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        await using (var guard = conn.CreateCommand())
        {
            guard.Transaction = tx;
            guard.CommandText = "SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 5000;";
            await guard.ExecuteNonQueryAsync(ct);
        }

        await using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql.TrimEnd(';');

        var rows = new List<Dictionary<string, object?>>();
        var truncated = false;
        try
        {
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                if (rows.Count >= MaxRows) { truncated = true; break; }
                var row = new Dictionary<string, object?>();
                for (var i = 0; i < reader.FieldCount; i++)
                    row[reader.GetName(i)] = JsonSafe(reader.IsDBNull(i) ? null : reader.GetValue(i));
                rows.Add(row);
            }
        }
        catch (PostgresException ex)
        {
            return $"Error: {ex.MessageText}";
        }
        finally
        {
            await tx.RollbackAsync(ct);
        }

        var result = JsonSerializer.Serialize(new { rowCount = rows.Count, truncated, rows });
        return result;
    }

    private static string? Validate(string sql)
    {
        if (string.IsNullOrWhiteSpace(sql)) return "'sql' is required.";
        var noTrailing = sql.TrimEnd(';').Trim();
        if (noTrailing.Contains(';')) return "Only a single statement is allowed.";
        var lower = noTrailing.ToLowerInvariant();
        if (!(lower.StartsWith("select") || lower.StartsWith("with")))
            return "Only read-only SELECT/WITH queries are allowed here. Use sql_exec (with confirmation) to modify data.";
        foreach (var d in Denied)
            if (lower.Contains(d))
                return $"Access to '{d}' is blocked (it holds secrets). Use get_storage_status / get_ai_keys_status instead.";
        return null;
    }

    private static object? JsonSafe(object? v) => v switch
    {
        null => null,
        bool or string or int or long or short or byte or float or double or decimal => v,
        DateTime dt => dt.ToString("o"),
        DateTimeOffset dto => dto.ToString("o"),
        Guid g => g.ToString(),
        _ => v.ToString(),
    };
}

/// <summary>Write/DDL SQL. NEVER auto-runs — always a proposal, and always forced to the typed-CONFIRM
/// gate by the server safety floor (it can do anything to the database).</summary>
public class SqlExecTool : IAiTool
{
    private readonly AppDbContext _db;
    public SqlExecTool(AppDbContext db) => _db = db;

    public string Name => "sql_exec";
    public string Description =>
        "Execute a data-modifying SQL statement (INSERT/UPDATE/DELETE/DDL). Requires explicit confirmation. " +
        "State precisely what it changes in change_summary.";
    public string ParametersJson => """
    {"type":"object","properties":{"sql":{"type":"string"},"change_summary":{"type":"string"},"dangerous":{"type":"boolean"}},"required":["sql","change_summary"]}
    """;
    public AiToolKind Kind => AiToolKind.Write;

    public bool ForceDangerous(JsonElement args) => true;

    public string Summarize(JsonElement args)
    {
        var sql = Args.Str(args, "sql") ?? "";
        return "Run SQL: " + (sql.Length > 200 ? sql[..200] + "…" : sql);
    }

    public async Task<string> ExecuteAsync(JsonElement args, CancellationToken ct)
    {
        var sql = (Args.Str(args, "sql") ?? "").Trim();
        if (string.IsNullOrWhiteSpace(sql)) return "Error: 'sql' is required.";
        try
        {
            var affected = await _db.Database.ExecuteSqlRawAsync(sql, ct);
            return $"Executed. Rows affected: {affected}.";
        }
        catch (Exception ex)
        {
            return $"Error: {ex.Message}";
        }
    }
}
