using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// The verbatim conversation record: every message the user sent and every message the assistant sent
/// back, stored as text. Voice messages and realtime calls arrive already transcribed — the browser is
/// the only place those transcripts exist (a Live call streams directly between the browser and Google,
/// and never passes through us), so recording is necessarily client-driven.
/// <para>
/// Separate from <c>/chat/memories</c> on purpose. That endpoint feeds recall: it clips content, embeds
/// it, mixes in summaries/digests, and its rows are removable one-by-one through the forget flow. This
/// one only has to be faithful — full text, every message including replies that errored, append-only.
/// The browser writes to both; neither depends on the other.
/// </para>
/// <para>
/// Writes are idempotent on the browser's message id, so the client can retry, re-send a reply once it
/// settles, and flush again as the tab closes without ever duplicating a message.
/// </para>
/// Scoped to the signed-in end-user (UserCookie); rows are removed only by deleting the account.
/// </summary>
[ApiController]
[Route("chat/transcript")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatTranscriptsController : ControllerBase
{
    private readonly AppDbContext _db;

    public ChatTranscriptsController(AppDbContext db) => _db = db;

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    // Bounds, not product limits — a faithful record shouldn't clip, so these sit far above any real
    // message and exist only so one request can't be used to write something unbounded. Content has no
    // expression index on it (see ChatTranscript), so long text costs storage and nothing else.
    private const int MaxContentChars = 1_000_000;
    private const int MaxMessagesPerRequest = 200;

    // How much of a message a *listing* returns. Storage is unclipped; this only stops one page of rows
    // from materializing an unbounded amount of text into memory. Far above any real message.
    private const int MaxListedChars = 32_000;

    public record TranscriptItem(
        string? ClientMessageId, string? Role, string? Modality, string? Text, DateTimeOffset? ClientCreatedAt);

    public record RecordTranscriptRequest(string? ConversationId, List<TranscriptItem>? Messages);

    public record TranscriptMessage(
        long Id, string ConversationId, string ClientMessageId, string Role, string Modality,
        string Content, DateTimeOffset? ClientCreatedAt, DateTimeOffset CreatedAt, bool Truncated);

    /// <summary>Record (or revise) messages. Each item carries the browser's own message id: a message
    /// already recorded under that id is updated in place, so retries and the re-send of a reply that
    /// grew while streaming both collapse onto one row. Returns how many rows were written vs updated.
    /// </summary>
    [HttpPost]
    public async Task<ActionResult> Record([FromBody] RecordTranscriptRequest req)
    {
        if (req.Messages is null || req.Messages.Count == 0)
            return BadRequest(new { error = "No messages to record." });
        if (req.Messages.Count > MaxMessagesPerRequest)
            return BadRequest(new { error = $"At most {MaxMessagesPerRequest} messages per request." });

        var convId = (req.ConversationId ?? "").Trim();
        if (convId.Length == 0) return BadRequest(new { error = "conversationId is required." });
        if (convId.Length > 64) convId = convId[..64];

        var uid = Uid;

        // Normalize first and drop anything unusable, so the id lookup below only asks about rows we
        // are actually going to write. Last item wins for a repeated id within one request.
        var incoming = new Dictionary<string, (string Role, string Modality, string Content, DateTimeOffset? At)>(
            StringComparer.Ordinal);
        foreach (var m in req.Messages)
        {
            var clientId = (m.ClientMessageId ?? "").Trim();
            var content = m.Text ?? "";
            // An empty message is nothing that was said — skip it rather than record a blank row.
            if (clientId.Length is 0 or > 64 || content.Trim().Length == 0) continue;
            if (content.Length > MaxContentChars) content = content[..MaxContentChars];
            incoming[clientId] = (
                m.Role == "assistant" ? "assistant" : "user",
                m.Modality is "voice" or "live" or "image" ? m.Modality : "text",
                content,
                m.ClientCreatedAt);
        }
        if (incoming.Count == 0) return Ok(new { recorded = 0, updated = 0 });

        var ids = incoming.Keys.ToList();

        // Two attempts. SaveChanges is one transaction for the whole batch, so if a concurrent flush of
        // the same message wins an insert between the read and the save, the unique index aborts
        // *everything* — including the messages only this request has. Re-reading turns the now-existing
        // ids into updates and saves once more, instead of dropping good messages on the floor.
        for (var attempt = 0; ; attempt++)
        {
            var existing = await _db.ChatTranscripts
                .Where(t => t.EndUserId == uid && ids.Contains(t.ClientMessageId))
                .ToDictionaryAsync(t => t.ClientMessageId, StringComparer.Ordinal);

            var now = DateTimeOffset.UtcNow;
            var recorded = 0;
            var updated = 0;
            foreach (var (clientId, item) in incoming)
            {
                if (existing.TryGetValue(clientId, out var row))
                {
                    // Only a genuine revision counts: a re-flush of identical text leaves the row untouched
                    // so UpdatedAt keeps meaning "when the wording last changed".
                    if (row.Content == item.Content && row.Role == item.Role && row.Modality == item.Modality) continue;
                    row.Content = item.Content;
                    row.Role = item.Role;
                    row.Modality = item.Modality;
                    row.UpdatedAt = now;
                    updated++;
                    continue;
                }

                _db.ChatTranscripts.Add(new ChatTranscript
                {
                    EndUserId = uid,
                    ConversationId = convId,
                    ClientMessageId = clientId,
                    Role = item.Role,
                    Modality = item.Modality,
                    Content = item.Content,
                    ClientCreatedAt = item.At,
                    CreatedAt = now,
                    UpdatedAt = now,
                });
                recorded++;
            }

            try
            {
                await _db.SaveChangesAsync();
                return Ok(new { recorded, updated });
            }
            catch (DbUpdateException) when (attempt == 0)
            {
                // Drop the failed plan entirely (tracked updates included) so the retry is built from
                // what is actually in the table now, not from stale tracked state.
                _db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>Read the record back, oldest-first within a conversation (newest-first across all of
    /// them when no conversation is given), so the user can see exactly what was stored about them.
    /// <para>
    /// A listing is bounded in bytes, not just rows: content is clipped by Postgres to
    /// <see cref="MaxListedChars"/> and flagged <c>truncated</c>, because rows are stored whole (up to
    /// <see cref="MaxContentChars"/>) and a page of them would otherwise be free to materialize hundreds
    /// of megabytes into memory. The stored row is untouched — only this view of it is bounded.
    /// </para></summary>
    [HttpGet]
    public async Task<IReadOnlyList<TranscriptMessage>> List(
        [FromQuery] string? conversationId, [FromQuery] int skip = 0, [FromQuery] int take = 100)
    {
        var uid = Uid;
        var t = Math.Clamp(take, 1, 200);
        var s = Math.Max(skip, 0);

        var query = _db.ChatTranscripts.AsNoTracking().Where(m => m.EndUserId == uid);
        if (!string.IsNullOrWhiteSpace(conversationId))
        {
            var convId = conversationId.Trim();
            query = query.Where(m => m.ConversationId == convId).OrderBy(m => m.Id);
        }
        else
        {
            // By CreatedAt, not Id: it means the same thing here (both rise with insertion) and it is
            // what IX_ChatTranscripts_EndUserId_CreatedAt can actually serve, so this stays an index
            // scan instead of a sort over every message the user has ever sent.
            query = query.OrderByDescending(m => m.CreatedAt).ThenByDescending(m => m.Id);
        }

        return await query
            .Skip(s)
            .Take(t)
            .Select(m => new TranscriptMessage(
                m.Id, m.ConversationId, m.ClientMessageId, m.Role, m.Modality,
                m.Content.Length > MaxListedChars ? m.Content.Substring(0, MaxListedChars) : m.Content,
                m.ClientCreatedAt, m.CreatedAt, m.Content.Length > MaxListedChars))
            .ToListAsync();
    }
}
