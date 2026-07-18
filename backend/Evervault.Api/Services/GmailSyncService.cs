using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Pulls each connected user's Gmail into <see cref="GmailMessage"/> rows so the chat can answer
/// from a local copy: an initial 30-day pull on connect, then incremental passes (Gmail history API)
/// every <see cref="SyncInterval"/>, with 30-day retention. Headers + extracted plain text only —
/// never attachments. Runs as a hosted singleton with a DI scope per unit of work (the
/// <see cref="Ai.VoiceReplySynthesizer"/> pattern); users sync sequentially, each isolated by its
/// own try/catch so one failing mailbox can never stall the rest. Single-container assumption
/// (documented app-wide): multi-instance would need per-user advisory locks.
/// </summary>
public sealed class GmailSyncService : BackgroundService
{
    private const string GmailBase = "https://gmail.googleapis.com/gmail/v1/users/me";

    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan SyncInterval = TimeSpan.FromMinutes(10);
    private const int RetentionDays = 30;
    private const int InitialSyncCap = 500;   // newest-first; truncation is logged, not an error
    private const int BodyCap = 20_000;
    private const int PageSize = 100;

    // Labels that mean "not real mail" — never stored.
    private static readonly string[] SkipLabels = ["DRAFT", "SPAM", "TRASH"];

    private readonly Channel<int> _wake = Channel.CreateUnbounded<int>();
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<GmailSyncService> _log;

    public GmailSyncService(IServiceScopeFactory scopes, ILogger<GmailSyncService> log)
    {
        _scopes = scopes;
        _log = log;
    }

    /// <summary>Ask for a user's sync to run as soon as possible (called right after a successful
    /// connect so the "syncing…" state starts within a second instead of at the next tick).</summary>
    public void RequestSyncNow(int endUserId) => _wake.Writer.TryWrite(endUserId);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // One reusable wake waiter across ticks: a cancelable WaitToReadAsync can't use the channel's
        // singleton waiter, so re-creating it every 60s would leak a pending op + token registration
        // per tick. Recreate only after it actually completes (a connect wrote to the channel).
        Task<bool>? wake = null;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var requested = new HashSet<int>();
                while (_wake.Reader.TryRead(out var uid)) requested.Add(uid);

                try
                {
                    await RunPassAsync(requested, stoppingToken);
                }
                // Only a genuine shutdown cancellation should stop the loop. An HttpClient timeout
                // throws TaskCanceledException (an OperationCanceledException) with stoppingToken NOT
                // canceled — that must fall through to the generic handler, never kill the service.
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "Gmail sync pass failed.");
                }

                // Sleep until the next tick — or wake immediately when a connect enqueues a user.
                wake ??= _wake.Reader.WaitToReadAsync(stoppingToken).AsTask();
                var completed = await Task.WhenAny(Task.Delay(TickInterval, stoppingToken), wake);
                if (completed == wake) wake = null;
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { /* app is shutting down */ }
    }

    private async Task RunPassAsync(HashSet<int> requested, CancellationToken ct)
    {
        List<int> dueUids;
        using (var scope = _scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            // Orphan sweep: messages whose owner no longer has a connection row (disconnect or account
            // delete raced an in-flight sync that kept inserting, or the row is simply gone). Cheap
            // anti-join on the EndUserId index; guarantees the promised deletion happens within a tick.
            await db.GmailMessages
                .Where(m => !db.GmailConnections.Any(c => c.EndUserId == m.EndUserId))
                .ExecuteDeleteAsync(ct);

            // Retention runs for ALL connections here (not only the ones syncing this pass): a revoked
            // grant stops syncing, so without this its mail would age past the 30-day window forever.
            await db.GmailMessages
                .Where(m => m.InternalDate < DateTimeOffset.UtcNow.AddDays(-RetentionDays))
                .ExecuteDeleteAsync(ct);

            var dueBefore = DateTimeOffset.UtcNow - SyncInterval;
            dueUids = await db.GmailConnections.AsNoTracking()
                .Where(c => c.Status == "connected" && c.ConnectedAt != null
                    && (requested.Contains(c.EndUserId) || c.LastSyncAt == null || c.LastSyncAt < dueBefore))
                .OrderBy(c => c.LastSyncAt == null ? 0 : 1).ThenBy(c => c.LastSyncAt)
                .Select(c => c.EndUserId)
                .ToListAsync(ct);
        }

        foreach (var uid in dueUids)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                await SyncUserAsync(uid, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Gmail sync failed for user {Uid}.", uid);
                await RecordFailureAsync(uid, ex.Message, ct);
            }
        }
    }

    private async Task SyncUserAsync(int uid, CancellationToken ct)
    {
        // Fresh scope per user: scoped AppDbContext/services, and a failed user's context never
        // leaks poisoned state into the next one.
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var oauth = scope.ServiceProvider.GetRequiredService<IGmailOAuthService>();
        var http = scope.ServiceProvider.GetRequiredService<IHttpClientFactory>().CreateClient();

        var conn = await db.GmailConnections.FirstOrDefaultAsync(c => c.EndUserId == uid, ct);
        if (conn is null || conn.Status != "connected") return;
        // Snapshot the connected account: if the user reconnects a DIFFERENT Gmail mid-pass,
        // CompleteAsync purges the old mail and resets sync bookkeeping — this in-flight pass must
        // not re-insert old-account messages or overwrite that reset. Checked before the final save.
        var accountSnapshot = conn.GmailSub;

        var token = await oauth.TryGetValidAccessTokenAsync(uid, ct);
        // Refresh may have marked the row revoked; it shares this scope's context, so re-check.
        await db.Entry(conn).ReloadAsync(ct);
        if (string.IsNullOrEmpty(token) || conn.Status != "connected")
        {
            conn.LastSyncAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return;
        }

        try
        {
            await SyncWithTokenAsync(db, conn, http, token, ct);
        }
        catch (GmailApiException ex) when (ex.StatusCode == 401)
        {
            // Stale access token despite the proactive skew — force one refresh and retry once.
            token = await oauth.ForceRefreshAsync(uid, ct);
            await db.Entry(conn).ReloadAsync(ct);
            if (string.IsNullOrEmpty(token) || conn.Status != "connected")
            {
                conn.LastSyncAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(ct);
                return;
            }
            await SyncWithTokenAsync(db, conn, http, token, ct);
        }

        // A disconnect / account-switch may have landed while we were fetching over HTTP. Reload and,
        // if the row is gone or now points at a different account, drop everything this pass staged AND
        // any batches it already committed (SyncWithTokenAsync saves in chunks), so stale mail from the
        // old account can't linger under the new one / after a disconnect. The next pass re-syncs fresh.
        await db.Entry(conn).ReloadAsync(ct);
        if (db.Entry(conn).State == EntityState.Detached || conn.Status != "connected" || conn.GmailSub != accountSnapshot)
        {
            db.ChangeTracker.Clear();
            await db.GmailMessages.Where(m => m.EndUserId == uid).ExecuteDeleteAsync(ct);
            return;
        }

        // Retention: drop the >30-day tail for this user (indexed on EndUserId+InternalDate).
        await db.GmailMessages
            .Where(m => m.EndUserId == uid && m.InternalDate < DateTimeOffset.UtcNow.AddDays(-RetentionDays))
            .ExecuteDeleteAsync(ct);

        conn.LastSyncAt = DateTimeOffset.UtcNow;
        conn.LastSyncError = null;
        conn.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    private async Task SyncWithTokenAsync(AppDbContext db, GmailConnection conn, HttpClient http, string token, CancellationToken ct)
    {
        if (!conn.InitialSyncDone || string.IsNullOrEmpty(conn.LastHistoryId))
        {
            await FullSyncAsync(db, conn, http, token, reconcile: false, ct);
            return;
        }

        try
        {
            await IncrementalSyncAsync(db, conn, http, token, ct);
        }
        catch (GmailApiException ex) when (ex.StatusCode is 404 or 400)
        {
            // startHistoryId expired (Gmail keeps history for roughly a week) — fall back to a full
            // re-list of the 30-day window, reconciling deletions we never saw.
            _log.LogInformation("Gmail history expired for user {Uid}; running full reconciliation.", conn.EndUserId);
            await FullSyncAsync(db, conn, http, token, reconcile: true, ct);
        }
    }

    // --- full sync (initial pull, and the history-expired reconciliation) ---

    private async Task FullSyncAsync(AppDbContext db, GmailConnection conn, HttpClient http, string token, bool reconcile, CancellationToken ct)
    {
        var uid = conn.EndUserId;

        // Snapshot the history cursor BEFORE listing: anything that arrives mid-crawl is replayed by
        // the first incremental pass instead of falling into a gap.
        using var profile = await GetJsonAsync(http, token, $"{GmailBase}/profile", ct);
        var historyId = ReadString(profile.RootElement, "historyId");

        var listedIds = new List<string>();
        string? pageToken = null;
        var truncated = false;
        do
        {
            var url = $"{GmailBase}/messages?q=newer_than:{RetentionDays}d&maxResults={PageSize}"
                + (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
            using var page = await GetJsonAsync(http, token, url, ct);
            if (page.RootElement.TryGetProperty("messages", out var msgs) && msgs.ValueKind == JsonValueKind.Array)
                foreach (var m in msgs.EnumerateArray())
                {
                    var id = ReadString(m, "id");
                    if (id.Length > 0) listedIds.Add(id);
                }
            pageToken = ReadString(page.RootElement, "nextPageToken") is { Length: > 0 } t ? t : null;
            if (listedIds.Count >= InitialSyncCap)
            {
                truncated = pageToken is not null;
                listedIds = listedIds.Take(InitialSyncCap).ToList();
                break;
            }
        } while (pageToken is not null);
        if (truncated)
            _log.LogInformation("Gmail sync for user {Uid} capped at {Cap} messages (mailbox has more in the window).",
                uid, InitialSyncCap);

        var existing = await db.GmailMessages
            .Where(m => m.EndUserId == uid)
            .ToDictionaryAsync(m => m.GmailId, ct);

        var processed = 0;
        foreach (var id in listedIds)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                if (existing.TryGetValue(id, out var row))
                {
                    // Already stored — refresh the label-derived flags only (bodies are immutable).
                    using var meta = await GetJsonAsync(http, token,
                        $"{GmailBase}/messages/{Uri.EscapeDataString(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject", ct);
                    ApplyLabels(row, meta.RootElement);
                    row.SyncedAt = DateTimeOffset.UtcNow;
                }
                else
                {
                    using var full = await GetJsonAsync(http, token,
                        $"{GmailBase}/messages/{Uri.EscapeDataString(id)}?format=full", ct);
                    var parsed = ParseMessage(uid, full.RootElement);
                    if (parsed is not null)
                    {
                        db.GmailMessages.Add(parsed);
                        existing[id] = parsed;
                    }
                }
            }
            catch (GmailApiException ex) when (ex.StatusCode == 404)
            {
                // Deleted mid-crawl — skip.
            }
            if (++processed % 25 == 0) await db.SaveChangesAsync(ct);
        }
        await db.SaveChangesAsync(ct);

        // Reconciliation (history-expired path): a message absent from an UN-truncated listing was
        // deleted at Gmail while we weren't looking — drop our copy. Skipped when capped, because
        // absence then proves nothing.
        if (reconcile && !truncated)
        {
            var listed = listedIds.ToHashSet();
            var windowStart = DateTimeOffset.UtcNow.AddDays(-RetentionDays);
            var stale = await db.GmailMessages
                .Where(m => m.EndUserId == uid && m.InternalDate >= windowStart)
                .Select(m => new { m.Id, m.GmailId })
                .ToListAsync(ct);
            var staleIds = stale.Where(s => !listed.Contains(s.GmailId)).Select(s => s.Id).ToList();
            if (staleIds.Count > 0)
                await db.GmailMessages.Where(m => staleIds.Contains(m.Id)).ExecuteDeleteAsync(ct);
        }

        if (!string.IsNullOrEmpty(historyId)) conn.LastHistoryId = historyId;
        conn.InitialSyncDone = true;
        await db.SaveChangesAsync(ct);
    }

    // --- incremental sync (history API) ---

    private async Task IncrementalSyncAsync(AppDbContext db, GmailConnection conn, HttpClient http, string token, CancellationToken ct)
    {
        var uid = conn.EndUserId;
        var deleted = new HashSet<string>();
        var touched = new HashSet<string>();
        string? newHistoryId = null;
        string? pageToken = null;

        do
        {
            var url = $"{GmailBase}/history?startHistoryId={Uri.EscapeDataString(conn.LastHistoryId!)}&maxResults={PageSize}"
                + (pageToken is null ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
            using var page = await GetJsonAsync(http, token, url, ct);
            var root = page.RootElement;
            if (ReadString(root, "historyId") is { Length: > 0 } h) newHistoryId = h;

            if (root.TryGetProperty("history", out var history) && history.ValueKind == JsonValueKind.Array)
                foreach (var rec in history.EnumerateArray())
                {
                    CollectIds(rec, "messagesDeleted", deleted);
                    CollectIds(rec, "messagesAdded", touched);
                    CollectIds(rec, "labelsAdded", touched);
                    CollectIds(rec, "labelsRemoved", touched);
                }

            pageToken = ReadString(root, "nextPageToken") is { Length: > 0 } t ? t : null;
        } while (pageToken is not null);

        touched.ExceptWith(deleted);

        var windowStart = DateTimeOffset.UtcNow.AddDays(-RetentionDays);
        foreach (var id in touched)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var row = await db.GmailMessages.FirstOrDefaultAsync(m => m.EndUserId == uid && m.GmailId == id, ct);
                if (row is not null)
                {
                    using var meta = await GetJsonAsync(http, token,
                        $"{GmailBase}/messages/{Uri.EscapeDataString(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject", ct);
                    // A message that gained a skip label (moved to trash/spam) leaves the store.
                    if (HasSkipLabel(meta.RootElement)) db.GmailMessages.Remove(row);
                    else
                    {
                        ApplyLabels(row, meta.RootElement);
                        row.SyncedAt = DateTimeOffset.UtcNow;
                    }
                }
                else
                {
                    using var full = await GetJsonAsync(http, token,
                        $"{GmailBase}/messages/{Uri.EscapeDataString(id)}?format=full", ct);
                    var parsed = ParseMessage(uid, full.RootElement);
                    if (parsed is not null && parsed.InternalDate >= windowStart)
                        db.GmailMessages.Add(parsed);
                }
            }
            catch (GmailApiException ex) when (ex.StatusCode == 404)
            {
                deleted.Add(id);
            }
        }
        await db.SaveChangesAsync(ct);

        if (deleted.Count > 0)
            await db.GmailMessages
                .Where(m => m.EndUserId == uid && deleted.Contains(m.GmailId))
                .ExecuteDeleteAsync(ct);

        if (!string.IsNullOrEmpty(newHistoryId)) conn.LastHistoryId = newHistoryId;
        await db.SaveChangesAsync(ct);
    }

    private static void CollectIds(JsonElement historyRecord, string field, HashSet<string> into)
    {
        if (!historyRecord.TryGetProperty(field, out var arr) || arr.ValueKind != JsonValueKind.Array) return;
        foreach (var item in arr.EnumerateArray())
            if (item.TryGetProperty("message", out var msg) && ReadString(msg, "id") is { Length: > 0 } id)
                into.Add(id);
    }

    // --- failure bookkeeping ---

    private async Task RecordFailureAsync(int uid, string message, CancellationToken ct)
    {
        try
        {
            using var scope = _scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var conn = await db.GmailConnections.FirstOrDefaultAsync(c => c.EndUserId == uid, ct);
            if (conn is null) return;

            var clipped = message.Length > 500 ? message[..500] : message;
            // One EV-code per distinct failure, not one per 10-minute retry.
            if (conn.LastSyncError != clipped)
            {
                var errors = scope.ServiceProvider.GetRequiredService<IErrorReportService>();
                await errors.CaptureAsync("backend", "gmail-sync", uid, null, "Gmail sync failed.", message);
            }
            conn.LastSyncError = clipped;
            conn.LastSyncAt = DateTimeOffset.UtcNow;   // natural retry pacing at the normal interval
            conn.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        catch { /* best-effort — never let bookkeeping mask the original failure */ }
    }

    // --- Gmail REST plumbing ---

    private sealed class GmailApiException : Exception
    {
        public int StatusCode { get; }
        public GmailApiException(int statusCode, string message) : base(message) => StatusCode = statusCode;
    }

    private static async Task<JsonDocument> GetJsonAsync(HttpClient http, string token, string url, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        using var res = await http.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            var detail = body.Length > 300 ? body[..300] : body;
            throw new GmailApiException((int)res.StatusCode, $"Gmail API {url.Split('?')[0]} failed (HTTP {(int)res.StatusCode}): {detail}");
        }
        return JsonDocument.Parse(body);
    }

    // --- message parsing ---

    /// <summary>Parse a format=full message into a row, or null when it isn't real mail (draft/spam/
    /// trash) or is malformed. Never throws — a single unparseable message must not sink the pass.</summary>
    private static GmailMessage? ParseMessage(int uid, JsonElement msg)
    {
        try
        {
            var id = ReadString(msg, "id");
            if (id.Length == 0 || HasSkipLabel(msg)) return null;

            var internalDate = ReadString(msg, "internalDate");
            var receivedAt = long.TryParse(internalDate, out var ms)
                ? DateTimeOffset.FromUnixTimeMilliseconds(ms)
                : DateTimeOffset.UtcNow;

            var (fromName, fromAddr) = ParseFrom(HeaderValue(msg, "From"));
            var row = new GmailMessage
            {
                EndUserId = uid,
                GmailId = Clip(id, 32),
                ThreadId = Clip(ReadString(msg, "threadId"), 32),
                FromAddr = Clip(fromAddr, 320),
                FromName = Clip(fromName, 256),
                ToAddr = Clip(HeaderValue(msg, "To"), 1000),
                Subject = Clip(HeaderValue(msg, "Subject"), 500),
                Snippet = Clip(WebUtility.HtmlDecode(ReadString(msg, "snippet")), 500),
                BodyText = ExtractBodyText(msg),
                InternalDate = receivedAt,
                SyncedAt = DateTimeOffset.UtcNow,
            };
            ApplyLabels(row, msg);
            return row;
        }
        catch
        {
            return null;
        }
    }

    private static void ApplyLabels(GmailMessage row, JsonElement msg)
    {
        var labels = ReadLabels(msg);
        row.IsUnread = labels.Contains("UNREAD");
        row.IsImportant = labels.Contains("IMPORTANT");
        row.IsStarred = labels.Contains("STARRED");
        row.Category = labels.FirstOrDefault(l => l.StartsWith("CATEGORY_", StringComparison.Ordinal)) is { } cat
            ? Clip(cat, 32) : row.Category;
    }

    private static bool HasSkipLabel(JsonElement msg) => ReadLabels(msg).Overlaps(SkipLabels);

    private static HashSet<string> ReadLabels(JsonElement msg)
    {
        var labels = new HashSet<string>(StringComparer.Ordinal);
        if (msg.TryGetProperty("labelIds", out var arr) && arr.ValueKind == JsonValueKind.Array)
            foreach (var l in arr.EnumerateArray())
                if (l.ValueKind == JsonValueKind.String) labels.Add(l.GetString()!);
        return labels;
    }

    private static string HeaderValue(JsonElement msg, string name)
    {
        if (!msg.TryGetProperty("payload", out var payload)
            || !payload.TryGetProperty("headers", out var headers)
            || headers.ValueKind != JsonValueKind.Array) return "";
        foreach (var h in headers.EnumerateArray())
            if (string.Equals(ReadString(h, "name"), name, StringComparison.OrdinalIgnoreCase))
                return ReadString(h, "value");
        return "";
    }

    private static (string Name, string Addr) ParseFrom(string from)
    {
        from = from.Trim();
        if (from.Length == 0) return ("", "");
        var lt = from.LastIndexOf('<');
        var gt = from.LastIndexOf('>');
        if (lt >= 0 && gt > lt)
        {
            var name = from[..lt].Trim().Trim('"');
            var addr = from[(lt + 1)..gt].Trim();
            return (name, addr);
        }
        return ("", from);
    }

    /// <summary>Extracted plain text: concatenated text/plain parts, else tag-stripped text/html,
    /// whitespace-collapsed and capped at <see cref="BodyCap"/>.</summary>
    private static string ExtractBodyText(JsonElement msg)
    {
        if (!msg.TryGetProperty("payload", out var payload)) return "";
        var plain = new StringBuilder();
        var html = new StringBuilder();
        WalkParts(payload, plain, html);

        var text = plain.Length > 0 ? plain.ToString() : StripHtml(html.ToString());
        try
        {
            text = Regex.Replace(text, @"[ \t\r]+", " ", RegexOptions.None, RegexTimeout);
            text = Regex.Replace(text, @" *\n *(\n *)+", "\n\n", RegexOptions.None, RegexTimeout);
        }
        catch (RegexMatchTimeoutException) { /* use the un-collapsed (already length-capped) text */ }
        text = text.Trim();
        return text.Length > BodyCap ? text[..BodyCap] + "…(truncated)" : text;
    }

    // Hard ceilings on how much raw part data we ever hold before capping. A single Gmail message can
    // be tens of MB (format=full inlines every part's data), so each decoded part is clipped to the
    // remaining budget BEFORE it lands in the builder — otherwise one giant part (or an attacker's
    // mail to a connected user) feeds a multi-MB string into the regex passes below.
    private const int PlainBudget = BodyCap * 2;
    private const int HtmlBudget = BodyCap * 4;
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(2);

    private static void WalkParts(JsonElement part, StringBuilder plain, StringBuilder html)
    {
        if (plain.Length >= PlainBudget) return; // enough plain text — stop decoding
        var mime = ReadString(part, "mimeType");
        if (part.TryGetProperty("body", out var body) && ReadString(body, "data") is { Length: > 0 } data)
        {
            if (mime.StartsWith("text/plain", StringComparison.OrdinalIgnoreCase))
                AppendClipped(plain, DecodeBase64Url(data), PlainBudget);
            else if (mime.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) && html.Length < HtmlBudget)
                AppendClipped(html, DecodeBase64Url(data), HtmlBudget);
        }
        if (part.TryGetProperty("parts", out var parts) && parts.ValueKind == JsonValueKind.Array)
            foreach (var child in parts.EnumerateArray())
                WalkParts(child, plain, html);
    }

    // Append at most (budget - current length) chars, so the builder never exceeds the budget.
    private static void AppendClipped(StringBuilder sb, string s, int budget)
    {
        var room = budget - sb.Length;
        if (room <= 0) return;
        sb.AppendLine(s.Length > room ? s[..room] : s);
    }

    private static string StripHtml(string html)
    {
        if (html.Length == 0) return "";
        try
        {
            // Bounded regex pass, not an HTML parser: drop script/style blocks, then all tags. The
            // match timeout guards against a crafted body (e.g. many unclosed <script> openers) turning
            // the lazy scans quadratic — on timeout we fall back to the raw (already length-capped) text.
            html = Regex.Replace(html, @"<(script|style)\b[^>]*>[\s\S]*?</\1\s*>", " ", RegexOptions.IgnoreCase, RegexTimeout);
            html = Regex.Replace(html, @"<br\s*/?>|</p>|</div>|</tr>", "\n", RegexOptions.IgnoreCase, RegexTimeout);
            html = Regex.Replace(html, @"<[^>]+>", " ", RegexOptions.None, RegexTimeout);
        }
        catch (RegexMatchTimeoutException) { /* keep whatever passes completed */ }
        return WebUtility.HtmlDecode(html);
    }

    private static string DecodeBase64Url(string s)
    {
        try
        {
            var t = s.Replace('-', '+').Replace('_', '/');
            switch (t.Length % 4) { case 2: t += "=="; break; case 3: t += "="; break; }
            return Encoding.UTF8.GetString(Convert.FromBase64String(t));
        }
        catch
        {
            return "";
        }
    }

    private static string ReadString(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? "" : "";

    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;
}
