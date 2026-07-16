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
/// In-memory (not R2) on purpose: the clip only has to survive from synthesis until the same session
/// retrieves it — seconds to a few minutes — so this needs no storage configuration and nothing to clean
/// up. Entries expire on a TTL and the registry is bounded by count and bytes. The webapp runs as a single
/// app container, so one process owning this state is sufficient.
/// </summary>
public sealed class VoiceReplySynthesizer : BackgroundService
{
    public enum ReplyStatus { Pending, Ready, Failed }

    /// <summary>A snapshot of one reply's synthesis: the status, and (when <see cref="ReplyStatus.Ready"/>)
    /// the raw mono PCM16 bytes plus their sample rate — the exact shape the browser's PCM player wants.</summary>
    public sealed record ReplyResult(ReplyStatus Status, byte[]? Pcm, int SampleRate);

    private sealed class Entry
    {
        public ReplyStatus Status;
        public byte[]? Pcm;
        public int SampleRate;
        public DateTimeOffset UpdatedAt;
    }

    private readonly record struct Job(string Key, int Uid, string Text, string Voice, string Model, string? UserAgent);

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
    public ReplyStatus Enqueue(int uid, string replyId, string text, string voice, string model, string? userAgent)
    {
        Sweep();
        var key = KeyFor(uid, replyId);
        var queue = false;

        var entry = _entries.AddOrUpdate(
            key,
            _ =>
            {
                queue = true;
                return new Entry { Status = ReplyStatus.Pending, UpdatedAt = DateTimeOffset.UtcNow };
            },
            (_, existing) =>
            {
                lock (existing)
                {
                    // Retry only a failed synthesis; a pending/ready one is returned as-is (idempotent).
                    if (existing.Status == ReplyStatus.Failed)
                    {
                        existing.Status = ReplyStatus.Pending;
                        existing.Pcm = null;
                        existing.UpdatedAt = DateTimeOffset.UtcNow;
                        queue = true;
                    }
                }
                return existing;
            });

        if (queue && !_jobs.Writer.TryWrite(new Job(key, uid, text, voice, model, userAgent)))
        {
            // Queue saturated — mark failed so the client stops waiting and just reveals the text.
            lock (entry) { entry.Status = ReplyStatus.Failed; entry.UpdatedAt = DateTimeOffset.UtcNow; }
        }

        lock (entry) return entry.Status;
    }

    /// <summary>Look up a reply's synthesis result, or null if we've never heard of it (or it was swept).</summary>
    public ReplyResult? TryGet(int uid, string replyId)
    {
        if (!_entries.TryGetValue(KeyFor(uid, replyId), out var e)) return null;
        lock (e) return new ReplyResult(e.Status, e.Pcm, e.SampleRate);
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
        try
        {
            // A fresh DI scope per job: KeyFailoverRunner (and its AppDbContext) are scoped, and this runs
            // outside any request scope. CancellationToken here is the app-lifetime token, NOT a client
            // request token — that's the whole point: synthesis completes even after the browser leaves.
            using var scope = _scopes.CreateScope();
            var failover = scope.ServiceProvider.GetRequiredService<KeyFailoverRunner>();
            var (pcm, mime) = await failover.RunAsync("gemini",
                (prov, key) => prov.SynthesizeSpeechAsync(key, job.Model, job.Text, job.Voice, ct),
                log: new AiCallContext { Area = "voice-reply", Model = job.Model, EndUserId = job.Uid });
            Complete(job.Key, pcm, WavWriter.SampleRateFromMime(mime));
        }
        catch (Exception ex)
        {
            Fail(job.Key);
            _log.LogWarning(ex, "Server-side voice-reply synthesis failed for user {Uid}.", job.Uid);
            // Record the failure for the admin error log (masked key hints already captured by the runner).
            try
            {
                using var scope = _scopes.CreateScope();
                var errors = scope.ServiceProvider.GetRequiredService<IErrorReportService>();
                await errors.CaptureAsync("backend", "voice-reply", job.Uid, 502,
                    "Server-side voice-reply synthesis failed.", ex.Message, job.UserAgent);
            }
            catch { /* best-effort — never let error logging mask the original failure */ }
        }
    }

    private void Complete(string key, byte[] pcm, int sampleRate)
    {
        if (_entries.TryGetValue(key, out var e))
            lock (e)
            {
                e.Status = ReplyStatus.Ready;
                e.Pcm = pcm;
                e.SampleRate = sampleRate;
                e.UpdatedAt = DateTimeOffset.UtcNow;
            }
        Sweep();
    }

    private void Fail(string key)
    {
        if (_entries.TryGetValue(key, out var e))
            lock (e)
            {
                e.Status = ReplyStatus.Failed;
                e.Pcm = null;
                e.UpdatedAt = DateTimeOffset.UtcNow;
            }
    }

    // Drop expired entries, then evict oldest-first while over the count/byte ceilings. Cheap and only
    // touched on enqueue/complete, so it never runs on the hot polling path.
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
            lock (e) sum += e.Pcm?.LongLength ?? 0;
        return sum;
    }
}
