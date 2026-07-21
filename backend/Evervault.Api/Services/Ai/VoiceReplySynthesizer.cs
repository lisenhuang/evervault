using System.Collections.Concurrent;
using System.Threading.Channels;
using Evervault.Api.Services;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// Generates the spoken audio for a /webapp voice-message reply <b>server-side</b>, decoupled from the
/// browser tab. The direct client-side TTS call runs inside the page and is killed the moment iOS Safari
/// suspends a backgrounded tab — so a user who fires a voice message and switches away comes back to the
/// reply text but no voice. Here the browser hands us the finished reply text; we synthesize the audio on
/// a background worker (via <see cref="KeyFailoverRunner"/>) that keeps running whether or not the client
/// is still connected, and stash the PCM in a short-lived in-memory registry the client polls
/// (immediately, and again whenever it returns to the foreground).
///
/// The reply is synthesized as one or more ordered <b>chunks</b>. With chunking off (the default) that's a
/// single chunk holding the whole clip — identical to the original behavior. With chunking on (an admin
/// opt-in) the text is split into sentences and each is synthesized in turn, appended as it lands, so the
/// client can start playing sentence one while the rest is still being generated. Either way the whole-clip
/// accessor (<see cref="TryGet"/>) returns the concatenation once every chunk is done, so an older client
/// that only knows the single-clip endpoint keeps working unchanged.
///
/// In-memory (not R2) on purpose: the clip only has to survive from synthesis until the same session
/// retrieves it — seconds to a few minutes — so this needs no storage configuration and nothing to clean
/// up. Entries expire on a TTL and the registry is bounded by count and bytes. The webapp runs as a single
/// app container, so one process owning this state is sufficient.
/// </summary>
public sealed class VoiceReplySynthesizer : BackgroundService
{
    public enum ReplyStatus { Pending, Ready, Failed }

    /// <summary>A snapshot of one reply's synthesis: the status, and (when <see cref="ReplyStatus.Ready"/>)
    /// the raw mono PCM16 bytes (all chunks concatenated) plus their sample rate — the exact shape the
    /// browser's PCM player wants.</summary>
    public sealed record ReplyResult(ReplyStatus Status, byte[]? Pcm, int SampleRate);

    /// <summary>One synthesized chunk: its ordinal position in the reply and the raw mono PCM16 bytes.</summary>
    public sealed record ReplyChunk(int Index, byte[] Pcm);

    /// <summary>A snapshot of a reply's chunk stream for incremental (SSE / poll) delivery: the chunks at or
    /// past the caller's cursor, how many are ready in total, the sample rate, and whether synthesis has
    /// finished producing chunks (<see cref="Ended"/>). When <see cref="Ended"/> is true and no chunk ever
    /// landed, the reply failed.</summary>
    public sealed record ChunkSnapshot(IReadOnlyList<ReplyChunk> NewChunks, int TotalReady, int SampleRate, bool Ended);

    private sealed class Entry
    {
        public readonly List<byte[]> Chunks = new();  // completed chunk PCM, in synthesis (playback) order
        public int SampleRate;                        // taken from the first chunk (all chunks share a rate)
        public bool Ended;                            // synthesis finished producing chunks (done or gave up)
        public DateTimeOffset UpdatedAt;

        // Overall status derives from the chunk state: pending until synthesis ends, then ready if any
        // chunk landed (whole or partial audio) or failed if none did.
        public ReplyStatus Status => !Ended ? ReplyStatus.Pending
            : Chunks.Count > 0 ? ReplyStatus.Ready : ReplyStatus.Failed;
    }

    private readonly record struct Job(string Key, int Uid, string Text, string Voice, string Model, bool Chunk, string? UserAgent);

    // How long a synthesized clip lingers before being swept. Generous enough to survive a user who
    // backgrounds the tab for a while and returns; short enough that idle memory is reclaimed.
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(30);
    private const int MaxEntries = 512;
    private const long MaxBytes = 128L * 1024 * 1024;   // ~128 MB ceiling across all cached clips
    private const int Workers = 4;                       // concurrent syntheses; one slow clip can't stall others

    private readonly ConcurrentDictionary<string, Entry> _entries = new();
    private readonly Channel<Job> _jobs = Channel.CreateBounded<Job>(
        new BoundedChannelOptions(256)
        {
            // Wait mode makes TryWrite return false (never block, never silently drop) when the queue is
            // full, so a saturated backend surfaces as a failed reply instead of a clip that never lands.
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = false,
            SingleWriter = false,
        });

    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<VoiceReplySynthesizer> _log;

    public VoiceReplySynthesizer(IServiceScopeFactory scopes, ILogger<VoiceReplySynthesizer> log)
    {
        _scopes = scopes;
        _log = log;
    }

    private static string KeyFor(int uid, string replyId) => $"{uid}:{replyId}";

    /// <summary>Register a reply for synthesis and return its current status. Idempotent: a reply that is
    /// already pending or ready is left untouched (a re-POST just reads the status back), while a
    /// previously-failed one is re-armed and queued again. Called from the request thread; the actual
    /// synthesis happens on the background workers.</summary>
    public ReplyStatus Enqueue(int uid, string replyId, string text, string voice, string model, bool chunk, string? userAgent)
    {
        Sweep();
        var key = KeyFor(uid, replyId);
        var queue = false;

        var entry = _entries.AddOrUpdate(
            key,
            _ =>
            {
                queue = true;
                return new Entry { UpdatedAt = DateTimeOffset.UtcNow };
            },
            (_, existing) =>
            {
                lock (existing)
                {
                    // Retry only a terminally-failed synthesis (ended with no audio); a pending or
                    // ready one is returned as-is (idempotent).
                    if (existing.Status == ReplyStatus.Failed)
                    {
                        existing.Chunks.Clear();
                        existing.Ended = false;
                        existing.UpdatedAt = DateTimeOffset.UtcNow;
                        queue = true;
                    }
                }
                return existing;
            });

        if (queue && !_jobs.Writer.TryWrite(new Job(key, uid, text, voice, model, chunk, userAgent)))
        {
            // Queue saturated — mark ended-with-no-audio (failed) so the client stops waiting and reveals text.
            lock (entry) { entry.Ended = true; entry.UpdatedAt = DateTimeOffset.UtcNow; }
        }

        lock (entry) return entry.Status;
    }

    /// <summary>Look up a reply's whole-clip result (every chunk concatenated), or null if we've never heard
    /// of it (or it was swept). <see cref="ReplyStatus.Ready"/> only once synthesis has fully finished — this
    /// is the backward-compatible accessor the original single-clip client polls.</summary>
    public ReplyResult? TryGet(int uid, string replyId)
    {
        if (!_entries.TryGetValue(KeyFor(uid, replyId), out var e)) return null;
        lock (e)
        {
            if (e.Status != ReplyStatus.Ready) return new ReplyResult(e.Status, null, e.SampleRate);
            return new ReplyResult(ReplyStatus.Ready, Concat(e.Chunks), e.SampleRate);
        }
    }

    /// <summary>Snapshot a reply's chunk stream from <paramref name="fromIndex"/> onward for incremental
    /// delivery (SSE / chunk poll), or null if unknown/swept. Chunks are contiguous and in playback order,
    /// so everything at or past the cursor is "new" to the caller.</summary>
    public ChunkSnapshot? TryGetChunks(int uid, string replyId, int fromIndex)
    {
        if (!_entries.TryGetValue(KeyFor(uid, replyId), out var e)) return null;
        lock (e)
        {
            var from = fromIndex < 0 ? 0 : fromIndex;
            var fresh = new List<ReplyChunk>();
            for (int i = from; i < e.Chunks.Count; i++) fresh.Add(new ReplyChunk(i, e.Chunks[i]));
            return new ChunkSnapshot(fresh, e.Chunks.Count, e.SampleRate, e.Ended);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var workers = Enumerable.Range(0, Workers)
            .Select(_ => Task.Run(() => WorkerLoopAsync(stoppingToken), stoppingToken));
        await Task.WhenAll(workers);
    }

    private async Task WorkerLoopAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var job in _jobs.Reader.ReadAllAsync(ct))
                await ProcessAsync(job, ct);
        }
        catch (OperationCanceledException) { /* app is shutting down */ }
    }

    private async Task ProcessAsync(Job job, CancellationToken ct)
    {
        // Split into sentence chunks when the admin opted in; otherwise synthesize the whole reply as one
        // chunk (byte-for-byte the original behavior). An empty split (shouldn't happen for non-empty text)
        // degrades to the whole text.
        var parts = job.Chunk ? SentenceChunker.Split(job.Text) : new List<string> { job.Text };
        if (parts.Count == 0) parts.Add(job.Text);

        try
        {
            // A fresh DI scope for the whole reply: KeyFailoverRunner (and its AppDbContext) are scoped, and
            // this runs outside any request scope. The CancellationToken here is the app-lifetime token, NOT a
            // client request token — that's the whole point: synthesis completes even after the browser leaves.
            using var scope = _scopes.CreateScope();
            var failover = scope.ServiceProvider.GetRequiredService<KeyFailoverRunner>();

            // Chunks are synthesized one at a time, in order: it preserves playback order without a reorder
            // buffer, and keeps a single reply to one in-flight TTS call at a time — gentler on a rate-limited
            // (free-tier) key than firing every sentence at once.
            for (int idx = 0; idx < parts.Count; idx++)
            {
                var (pcm, mime) = await failover.RunAsync("gemini",
                    (prov, key) => prov.SynthesizeSpeechAsync(key, job.Model, parts[idx], job.Voice, ct),
                    log: new AiCallContext { Area = "voice-reply", Model = job.Model, EndUserId = job.Uid });
                AppendChunk(job.Key, pcm, WavWriter.SampleRateFromMime(mime));
            }
        }
        catch (Exception ex)
        {
            // A chunk failed. Anything synthesized before it is kept (the client plays what landed, then
            // reveals the remaining text without audio); if nothing landed at all this reads as a failure.
            _log.LogWarning(ex, "Server-side voice-reply synthesis failed for user {Uid}.", job.Uid);
            try
            {
                using var scope = _scopes.CreateScope();
                var errors = scope.ServiceProvider.GetRequiredService<IErrorReportService>();
                await errors.CaptureAsync("backend", "voice-reply", job.Uid, 502,
                    "Server-side voice-reply synthesis failed.", ex.Message, job.UserAgent);
            }
            catch { /* best-effort — never let error logging mask the original failure */ }
        }
        finally
        {
            MarkEnded(job.Key);
        }
    }

    private void AppendChunk(string key, byte[] pcm, int sampleRate)
    {
        if (_entries.TryGetValue(key, out var e))
            lock (e)
            {
                if (e.Chunks.Count == 0) e.SampleRate = sampleRate; // all chunks share the model's rate
                e.Chunks.Add(pcm);
                e.UpdatedAt = DateTimeOffset.UtcNow;
            }
        Sweep();
    }

    private void MarkEnded(string key)
    {
        if (_entries.TryGetValue(key, out var e))
            lock (e)
            {
                e.Ended = true;
                e.UpdatedAt = DateTimeOffset.UtcNow;
            }
    }

    private static byte[] Concat(List<byte[]> chunks)
    {
        if (chunks.Count == 1) return chunks[0];
        long total = 0;
        foreach (var c in chunks) total += c.LongLength;
        var all = new byte[total];
        var off = 0;
        foreach (var c in chunks) { Buffer.BlockCopy(c, 0, all, off, c.Length); off += c.Length; }
        return all;
    }

    // Drop expired entries, then evict oldest-first while over the count/byte ceilings. Cheap and only
    // touched on enqueue/append, so it never runs on the hot polling path.
    private void Sweep()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var (k, e) in _entries)
        {
            bool expired;
            lock (e) expired = now - e.UpdatedAt > Ttl;
            if (expired) _entries.TryRemove(k, out _);
        }

        if (_entries.Count <= MaxEntries && TotalBytes() <= MaxBytes) return;

        foreach (var k in _entries.OrderBy(OldestFirst).Select(kv => kv.Key).ToList())
        {
            if (_entries.Count <= MaxEntries && TotalBytes() <= MaxBytes) break;
            _entries.TryRemove(k, out _);
        }
    }

    private static DateTimeOffset OldestFirst(KeyValuePair<string, Entry> kv)
    {
        lock (kv.Value) return kv.Value.UpdatedAt;
    }

    private long TotalBytes()
    {
        long sum = 0;
        foreach (var e in _entries.Values)
            lock (e)
                foreach (var c in e.Chunks) sum += c.LongLength;
        return sum;
    }
}
