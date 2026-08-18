using System.Security.Claims;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Controllers;

/// <summary>
/// The user's conversations, as a list they can browse and come back to.
/// <para>
/// A conversation is not stored anywhere as a row. It is the set of <see cref="ChatTranscript"/>
/// messages sharing a <c>ConversationId</c> — a token the browser mints per chat and has been tagging
/// every message with since long before this endpoint existed. So the list is <b>derived</b>, and that
/// is the point: every conversation the user has ever held is already in it, including ones from before
/// the sidebar could show them, and a browser tab running the previous release keeps producing listable
/// conversations without knowing this endpoint exists.
/// </para>
/// <para>
/// <see cref="ChatConversation"/> is only an overlay for what the user has decided about a conversation
/// (today: pinned), LEFT-JOINed on. A conversation with no row there is the normal case, not a gap.
/// </para>
/// <para>
/// Titles are derived too — the opening words of the first thing the user said — rather than generated
/// or stored. It costs nothing, it is never stale, and it needs no write path on a surface where the
/// client may be a version behind.
/// </para>
/// Scoped to the signed-in end-user (UserCookie).
/// </summary>
[ApiController]
[Route("chat/conversations")]
[Authorize(AuthenticationSchemes = AuthController.Scheme)]
public class ChatConversationsController : ControllerBase
{
    private readonly AppDbContext _db;

    public ChatConversationsController(AppDbContext db) => _db = db;

    private int Uid => int.Parse(User.FindFirst(ClaimTypes.NameIdentifier)!.Value);

    // How many conversations one grouping pass will carry back from the database. A bound on transfer,
    // not a product limit: a user who has been here for years accumulates a conversation per "New chat",
    // and the sidebar shows the recent end of that. Pinned conversations older than this cut-off are
    // fetched separately (see List) so a pin can never fall off the list it was meant to hold something on.
    private const int MaxConversations = 400;
    // How much of the opening message is read for a title. The sidebar shows one truncated line; the
    // rest would be transferred only to be thrown away, and messages can be a megabyte.
    private const int MaxTitleChars = 120;

    /// <param name="ConversationId">The browser's own id for the conversation — what the client passes
    /// back to reopen it.</param>
    /// <param name="Title">Opening words of the first thing the user said in it, clipped. Empty when the
    /// conversation opens with something that left no text (a photo with no caption, say); the client
    /// falls back to its own label rather than showing a blank row.</param>
    /// <param name="Pinned">Whether the user pinned it. False when there is no preferences row at all.</param>
    /// <param name="LastMessageAt">When the most recent message in it was recorded — what the list sorts by.</param>
    /// <param name="MessageCount">How many messages it holds, for a subtitle.</param>
    public record ConversationDto(
        string ConversationId, string Title, bool Pinned, DateTimeOffset LastMessageAt, int MessageCount);

    /// <summary>What the user decided about a conversation. Every field optional so this can grow
    /// (archive, a chosen title) without an older client's request meaning something new.</summary>
    public record ConversationPrefsPatch(bool? Pinned);

    public record ConversationPrefsDto(string ConversationId, bool Pinned);

    /// <summary>The conversation list: pinned first, then most recently spoken in. Derived from the
    /// transcript on every call — there is no list to keep in sync, and nothing to backfill.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<ConversationDto>> List([FromQuery] int skip = 0, [FromQuery] int take = 50)
    {
        var uid = Uid;
        var t = Math.Clamp(take, 1, 200);
        var s = Math.Max(skip, 0);

        // What the user has decided about any of their conversations. Small (a row exists only once a
        // preference has been expressed) and needed up front, because a pin has to survive the recency
        // cut-off below.
        var prefs = await _db.ChatConversations.AsNoTracking()
            .Where(c => c.EndUserId == uid)
            .ToDictionaryAsync(c => c.ConversationId, c => c.Pinned, StringComparer.Ordinal);

        var groups = await GroupConversations(uid).OrderByDescending(g => g.LastId).Take(MaxConversations).ToListAsync();

        // A conversation pinned long ago can sit outside the most-recent window above, and dropping it
        // would quietly undo the one thing a pin is for. Fetch any such stragglers by id.
        var pinnedIds = prefs.Where(p => p.Value).Select(p => p.Key).ToHashSet(StringComparer.Ordinal);
        pinnedIds.ExceptWith(groups.Select(g => g.ConversationId));
        if (pinnedIds.Count > 0) groups.AddRange(await GroupConversations(uid, pinnedIds.ToList()).ToListAsync());

        // One row per conversation carries the timestamp and the title; read them in a single pass by id
        // rather than dragging every message's text through the grouping above.
        var anchorIds = groups.Select(g => g.LastId)
            .Concat(groups.Where(g => g.FirstUserId != null).Select(g => g.FirstUserId!.Value))
            .Distinct()
            .ToList();
        var anchors = await _db.ChatTranscripts.AsNoTracking()
            .Where(m => m.EndUserId == uid && anchorIds.Contains(m.Id))
            .Select(m => new
            {
                m.Id,
                m.CreatedAt,
                Head = m.Content.Length > MaxTitleChars ? m.Content.Substring(0, MaxTitleChars) : m.Content,
            })
            .ToDictionaryAsync(a => a.Id);

        return groups
            .Select(g =>
            {
                var last = anchors.TryGetValue(g.LastId, out var l) ? l.CreatedAt : DateTimeOffset.MinValue;
                var title = g.FirstUserId != null && anchors.TryGetValue(g.FirstUserId.Value, out var f) ? f.Head : "";
                return new ConversationDto(
                    g.ConversationId, TitleLine(title), prefs.GetValueOrDefault(g.ConversationId), last, g.Count);
            })
            .OrderByDescending(c => c.Pinned)
            .ThenByDescending(c => c.LastMessageAt)
            .Skip(s)
            .Take(t)
            .ToList();
    }

    /// <summary>Set what the user has decided about one conversation, creating the row the first time.
    /// Rejects an id with no messages behind it, so a stale or made-up token can't leave a preference
    /// row pointing at nothing.</summary>
    [HttpPut("{conversationId}")]
    public async Task<ActionResult<ConversationPrefsDto>> SetPrefs(string conversationId, [FromBody] ConversationPrefsPatch req)
    {
        var uid = Uid;
        var convId = (conversationId ?? "").Trim();
        if (convId.Length is 0 or > 64) return BadRequest(new { error = "conversationId is required." });

        if (!await _db.ChatTranscripts.AnyAsync(m => m.EndUserId == uid && m.ConversationId == convId))
            return NotFound();

        // Two attempts, matching the transcript recorder's reasoning: two tabs can pin the same
        // conversation at once, and the loser of that race should update the row the winner just
        // created rather than fail the user's tap.
        for (var attempt = 0; ; attempt++)
        {
            var row = await _db.ChatConversations.FirstOrDefaultAsync(c => c.EndUserId == uid && c.ConversationId == convId);
            var now = DateTimeOffset.UtcNow;
            if (row is null)
            {
                row = new ChatConversation { EndUserId = uid, ConversationId = convId, CreatedAt = now, UpdatedAt = now };
                _db.ChatConversations.Add(row);
            }

            if (req?.Pinned is bool pinned && pinned != row.Pinned)
            {
                row.Pinned = pinned;
                row.UpdatedAt = now;
            }

            try
            {
                await _db.SaveChangesAsync();
                return Ok(new ConversationPrefsDto(convId, row.Pinned));
            }
            catch (DbUpdateException) when (attempt == 0)
            {
                _db.ChangeTracker.Clear();
            }
        }
    }

    /// <summary>One grouped row per conversation: its newest message (what the list sorts by), the first
    /// thing the user said in it (what the title comes from), and how many messages it holds. Every
    /// column here is served by IX_ChatTranscripts_EndUserId_ConversationId_Id, so this stays an index
    /// pass rather than a walk over the text of every message the user has ever sent.</summary>
    private IQueryable<ConversationGroup> GroupConversations(int uid, IReadOnlyList<string>? only = null)
    {
        var rows = _db.ChatTranscripts.AsNoTracking().Where(m => m.EndUserId == uid);
        // Narrowing BEFORE the grouping, not after: a filter on the grouped projection becomes a HAVING
        // over every conversation the user has, where this stays an index range read of the few asked for.
        if (only is not null) rows = rows.Where(m => only.Contains(m.ConversationId));
        return rows
            .GroupBy(m => m.ConversationId)
            .Select(g => new ConversationGroup(
                g.Key,
                g.Max(m => m.Id),
                // The first message the USER sent — the assistant's opening line would title every
                // conversation the same way. Null when they never typed one (a call, say).
                g.Min(m => m.Role == "user" ? (long?)m.Id : null),
                g.Count()));
    }

    private record ConversationGroup(string ConversationId, long LastId, long? FirstUserId, int Count);

    /// <summary>Squash an opening message into one line of title. Newlines become spaces (a pasted block
    /// would otherwise render as a tall blank row) and the result is trimmed; the client decides how much
    /// of it fits.</summary>
    private static string TitleLine(string head) =>
        string.Join(' ', head.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim();
}
