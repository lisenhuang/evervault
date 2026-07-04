using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Evervault.Api.Data;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// Relays the native app's realtime voice call to the Gemini Live (BidiGenerateContent) WebSocket,
/// injecting a system key server-side. The app connects to <c>/chat/ai/live</c> and sends the exact
/// setup + audio frames the @google/genai SDK would send (minus the key); this relay opens the upstream
/// Google socket with a system key, does key-failover at setup, then pumps frames verbatim in both
/// directions. Function calls (memory recall) travel through untouched — the app runs the tool itself
/// via the ordinary /chat/ai + /chat/memories endpoints — so the relay stays a dumb, stateless pipe.
/// </summary>
public class LiveRelay
{
    private const string LiveUrl =
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=";
    private const int BufferSize = 1 << 16; // 64 KB receive chunks

    private readonly AppDbContext _db;
    private readonly IDataProtector _protector;
    private readonly ILogger<LiveRelay> _log;

    public LiveRelay(AppDbContext db, IDataProtectionProvider dp, ILogger<LiveRelay> log)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.AiKey");
        _log = log;
    }

    public async Task RunAsync(WebSocket client, CancellationToken ct)
    {
        // 1. The client's first frame is the BidiGenerateContent setup (model, voice, system instruction,
        //    tools, VAD config) — exactly what the SDK sends, minus the key.
        var (setup, setupType, closed) = await ReceiveMessageAsync(client, ct);
        if (closed || setup is null)
        {
            await SafeClose(client, "No setup frame received.");
            return;
        }

        // 2. Load enabled system Gemini keys in failover order.
        var keys = await LoadKeysAsync(ct);
        if (keys.Count == 0)
        {
            await SendJson(client, new { error = "No Gemini API keys are configured on the server." }, ct);
            await SafeClose(client, "No keys configured.");
            return;
        }

        // 3. Try each key until one reaches setup (i.e. sends its first upstream frame without closing).
        ClientWebSocket? upstream = null;
        byte[]? firstUpstream = null;
        var firstType = WebSocketMessageType.Text;
        var errors = new List<string>();

        foreach (var (hint, key) in keys)
        {
            var ws = new ClientWebSocket();
            try
            {
                using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                connectCts.CancelAfter(TimeSpan.FromSeconds(15));
                await ws.ConnectAsync(new Uri(LiveUrl + Uri.EscapeDataString(key)), connectCts.Token);
                await ws.SendAsync(setup.AsMemory(), setupType, endOfMessage: true, connectCts.Token);

                var (msg, type, upClosed) = await ReceiveMessageAsync(ws, connectCts.Token);
                if (upClosed || msg is null)
                {
                    errors.Add($"{hint}: upstream closed during setup ({ws.CloseStatusDescription ?? "no detail"}).");
                    Abort(ws);
                    continue;
                }
                upstream = ws;
                firstUpstream = msg;
                firstType = type;
                break;
            }
            catch (Exception ex)
            {
                errors.Add($"{hint}: {ex.Message}");
                Abort(ws);
            }
        }

        if (upstream is null || firstUpstream is null)
        {
            _log.LogWarning("Live relay: all keys failed at setup: {Errors}", string.Join(" | ", errors));
            await SendJson(client, new { error = "Could not start a live session: " + string.Join(" ", errors) }, ct);
            await SafeClose(client, "All keys failed at setup.");
            return;
        }

        // 4. Forward the first upstream frame (setupComplete), then pump both directions until either ends.
        try
        {
            await client.SendAsync(firstUpstream.AsMemory(), firstType, endOfMessage: true, ct);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var up = PumpAsync(client, upstream, linked.Token);
            var down = PumpAsync(upstream, client, linked.Token);
            await Task.WhenAny(up, down);
            await linked.CancelAsync();
            await Task.WhenAll(Swallow(up), Swallow(down));
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Live relay pump ended");
        }
        finally
        {
            Abort(upstream);
            await SafeClose(client, "Session ended.");
        }
    }

    /// <summary>Copy whole messages from <paramref name="src"/> to <paramref name="dst"/> until either closes.</summary>
    private static async Task PumpAsync(WebSocket src, WebSocket dst, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && src.State == WebSocketState.Open)
        {
            var (msg, type, closed) = await ReceiveMessageAsync(src, ct);
            if (closed || msg is null) return;
            if (dst.State == WebSocketState.Open)
                await dst.SendAsync(msg.AsMemory(), type, endOfMessage: true, ct);
        }
    }

    private static async Task<(byte[]? Data, WebSocketMessageType Type, bool Closed)> ReceiveMessageAsync(
        WebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[BufferSize];
        using var ms = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            try { result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct); }
            catch { return (null, WebSocketMessageType.Close, true); }
            if (result.MessageType == WebSocketMessageType.Close) return (null, WebSocketMessageType.Close, true);
            ms.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);
        return (ms.ToArray(), result.MessageType, false);
    }

    private async Task<List<(string Hint, string Key)>> LoadKeysAsync(CancellationToken ct)
    {
        var rows = await _db.AiKeys.AsNoTracking()
            .Where(k => k.Provider == "gemini" && k.Enabled)
            .OrderBy(k => k.SortOrder).ThenBy(k => k.Id)
            .ToListAsync(ct);

        var result = new List<(string, string)>();
        foreach (var k in rows)
        {
            try { result.Add((k.KeyHint, _protector.Unprotect(k.KeyEncrypted))); }
            catch { /* skip undecryptable */ }
        }
        return result;
    }

    private static async Task SendJson(WebSocket ws, object payload, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        try { await ws.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, ct); }
        catch { /* client gone */ }
    }

    private static async Task SafeClose(WebSocket ws, string reason)
    {
        if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, reason, CancellationToken.None); }
            catch { /* ignore */ }
        }
    }

    private static void Abort(WebSocket ws)
    {
        try { ws.Abort(); } catch { /* ignore */ }
        try { ws.Dispose(); } catch { /* ignore */ }
    }

    private static async Task Swallow(Task t)
    {
        try { await t; } catch { /* ignore */ }
    }
}
