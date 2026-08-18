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
/// A conversation shows the name it was given — a short summary the browser writes after the opening
/// exchange, or whatever the user renamed it to — and falls back to the opening words of what was said
/// when it has neither. That fallback is what every conversation held before any of this existed still
/// shows, with nothing to backfill.
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
    // How much of the opening message is read for a derived title, and the ceiling on a stored one.
    // The sidebar shows one truncated line; the rest would be transferred only to be thrown away, and
    // messages can be a megabyte. Matches the column's own 200, clipped here so a long name is trimmed
    // rather than rejected.
    private const int MaxTitleChars = 200;

    /// <param name="ConversationId">The browser's own id for the conversation — what the client passes
    /// back to reopen it.</param>
    /// <param name="Title">What to show in the list: the stored name if it has one, otherwise the
    /// opening words of the first thing the user said. Empty when the conversation opens with something
    /// that left no text (a photo with no caption, say); the client falls back to its own label rather
    /// than showing a blank row.</param>
    /// <param name="Pinned">Whether the user pinned it. False when there is no preferences row at all.</param>
    /// <param name="LastMessageAt">When the most recent message in it was recorded — what the list sorts by.</param>
    /// <param name="MessageCount">How many messages it holds, for a subtitle.</param>
    /// <param name="Named">Whether <paramref name="Title"/> is a stored name rather than the fallback.
    /// It is what stops the browser summarising a title for a conversation that already has one — and
    /// it is appended last with a default, so a client from before this field existed still
    /// deserializes the response.</param>
    public record ConversationDto(
        string ConversationId, string Title, bool Pinned, DateTimeOffset LastMessageAt, int MessageCount,
        bool Named = false);

    /// <summary>What the user decided about a conversation. Every field is optional so this can grow
    /// without an older client's request meaning something new: an absent field is "leave it alone",
    /// which is exactly what a client that has never heard of it sends.
    /// <para>
    /// An explicitly empty Title is the one exception — it means "forget the name", putting the
    /// conversation back to being labelled by its opening words. There is no other way to say that,
    /// since null already means "don't touch it".
    /// </para></summary>
    public record ConversationPrefsPatch(bool? Pinned, string? Title = null);

    public record ConversationPrefsDto(string ConversationId, bool Pinned, string? Title = null);

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
            .ToDictionaryAsync(c => c.ConversationId, c => new { c.Pinned, c.Title }, StringComparer.Ordinal);

        var groups = await GroupConversations(uid).OrderByDescending(g => g.LastId).Take(MaxConversations).ToListAsync();

        // A conversation pinned long ago can sit outside the most-recent window above, and dropping it
        // would quietly undo the one thing a pin is for. Fetch any such stragglers by id.
        var pinnedIds = prefs.Where(p => p.Value.Pinned).Select(p => p.Key).ToHashSet(StringComparer.Ordinal);
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
                var pref = prefs.GetValueOrDefault(g.ConversationId);
                var named = !string.IsNullOrWhiteSpace(pref?.Title);
                // The stored name if it has one; otherwise the opening words of what the user said.
                var title = named
                    ? pref!.Title!
                    : g.FirstUserId != null && anchors.TryGetValue(g.FirstUserId.Value, out var f) ? f.Head : "";
                return new ConversationDto(
                    g.ConversationId, TitleLine(title), pref?.Pinned ?? false, last, g.Count, named);
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

            if (req?.Title is not null)
            {
                // Squashed to one line and clipped, for the same reason the derived title is: this is a
                // sidebar row, and a pasted paragraph would render as a tall blank one.
                var title = TitleLine(req.Title);
                var next = title.Length == 0 ? null : Clip(title, MaxTitleChars);
                if (next != row.Title)
                {
                    row.Title = next;
                    row.UpdatedAt = now;
                }
            }

            try
            {
                await _db.SaveChangesAsync();
                return Ok(new ConversationPrefsDto(convId, row.Pinned, row.Title));
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
            // Member-init, not a constructor: EF translates a grouped aggregate only when the projection
            // binds members it can see (an anonymous type or an object initializer). A positional record's
            // constructor call carries no member bindings, and the whole query fails at runtime — which an
            // empty sidebar in production is how we found out.
            .Select(g => new ConversationGroup
            {
                ConversationId = g.Key,
                LastId = g.Max(m => m.Id),
                // The first message the USER sent — the assistant's opening line would title every
                // conversation the same way. Null when they never typed one (a call, say).
                FirstUserId = g.Min(m => m.Role == "user" ? (long?)m.Id : null),
                Count = g.Count(),
            });
    }

    private sealed class ConversationGroup
    {
        public string ConversationId { get; set; } = string.Empty;
        public long LastId { get; set; }
        public long? FirstUserId { get; set; }
        public int Count { get; set; }
    }

    /// <summary>Squash an opening message into one line of title. Newlines become spaces (a pasted block
    /// would otherwise render as a tall blank row) and the result is trimmed; the client decides how much
    /// of it fits.</summary>
    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;

    private static string TitleLine(string head) =>
        string.Join(' ', head.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim();
}
