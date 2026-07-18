using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Per-user Gmail OAuth (authorization code + PKCE), modeled on <see cref="OpenAiOAuthService"/> but
/// keyed by <see cref="GmailConnection.EndUserId"/> instead of a single row. Reuses the admin's
/// Google OAuth client from <see cref="GoogleAuthConfig"/> (secret purpose must match
/// <see cref="GoogleAuthService"/>). Google refresh tokens don't rotate, but refresh keeps the
/// rotation-safe shape (per-user lock + reload/double-check) — it costs nothing and survives
/// overlapping deploys. An <c>invalid_grant</c> (user revoked at Google, password change, or the
/// 7-day Testing-mode expiry) marks the row revoked so the chat can offer a reconnect.
/// </summary>
public class GmailOAuthService : IGmailOAuthService
{
    private const string AuthorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
    private const string TokenEndpoint = "https://oauth2.googleapis.com/token";
    private const string RevokeEndpoint = "https://oauth2.googleapis.com/revoke";
    private const string GmailScope = "https://www.googleapis.com/auth/gmail.readonly";
    private const string Scope = $"openid email {GmailScope}";

    private static readonly TimeSpan RefreshSkew = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan PendingTtl = TimeSpan.FromMinutes(10);

    // Per-user refresh serialization (two tabs / the sync loop must not race the same token).
    private static readonly ConcurrentDictionary<int, SemaphoreSlim> RefreshLocks = new();

    private readonly AppDbContext _db;
    private readonly IDataProtector _protector;
    private readonly IDataProtector _googleSecretProtector;
    private readonly IHttpClientFactory _http;

    public GmailOAuthService(AppDbContext db, IDataProtectionProvider dp, IHttpClientFactory http)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.GmailOAuth");
        // Must match GoogleAuthService's purpose exactly or the stored client secret won't unprotect.
        _googleSecretProtector = dp.CreateProtector("Evervault.GoogleAuthSecret");
        _http = http;
    }

    public async Task<bool> IsAvailableAsync(CancellationToken ct) =>
        (await GetClientCredentialsAsync(ct)) is not null;

    public async Task<string> BuildAuthorizeUrlAsync(int endUserId, string redirectUri, string? loginHint, CancellationToken ct)
    {
        var creds = await GetClientCredentialsAsync(ct)
            ?? throw new InvalidOperationException("Gmail connection isn't available: Google sign-in or the client secret isn't configured.");

        var verifier = Base64Url(RandomNumberGenerator.GetBytes(64));
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var state = Base64Url(RandomNumberGenerator.GetBytes(32));

        var conn = await GetOrCreateAsync(endUserId, ct);
        conn.PendingState = state;
        conn.PendingCodeVerifier = verifier;
        conn.PendingCreatedAt = DateTimeOffset.UtcNow;
        conn.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        var q = new Dictionary<string, string>
        {
            ["response_type"] = "code",
            ["client_id"] = creds.ClientId,
            ["redirect_uri"] = redirectUri,
            ["scope"] = Scope,
            // offline is mandatory for a refresh token; consent guarantees one on EVERY connect
            // (Google only issues it on consent), so a reconnect can never end up half-connected.
            ["access_type"] = "offline",
            ["prompt"] = "select_account consent",
            ["state"] = state,
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256",
        };
        if (!string.IsNullOrWhiteSpace(loginHint)) q["login_hint"] = loginHint;

        return AuthorizeEndpoint + "?" + string.Join("&",
            q.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
    }

    public async Task<GmailConnectResult> CompleteAsync(int endUserId, string code, string state, string redirectUri, CancellationToken ct)
    {
        var conn = await _db.GmailConnections.FirstOrDefaultAsync(c => c.EndUserId == endUserId, ct);
        if (conn is null || string.IsNullOrWhiteSpace(conn.PendingState) || string.IsNullOrWhiteSpace(conn.PendingCodeVerifier))
            return new GmailConnectResult(false, null, "no_pending");
        if (conn.PendingCreatedAt is null || DateTimeOffset.UtcNow - conn.PendingCreatedAt > PendingTtl)
        {
            await ClearPendingAsync(conn, ct);
            return new GmailConnectResult(false, null, "expired");
        }
        if (!FixedTimeEquals(state, conn.PendingState))
            return new GmailConnectResult(false, null, "state_mismatch");

        var creds = await GetClientCredentialsAsync(ct);
        if (creds is null) return new GmailConnectResult(false, null, "exchange_failed");

        GoogleTokenResponse token;
        try
        {
            token = await PostTokenAsync(new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["code"] = code,
                ["redirect_uri"] = redirectUri,
                ["client_id"] = creds.Value.ClientId,
                ["client_secret"] = creds.Value.ClientSecret,
                ["code_verifier"] = conn.PendingCodeVerifier!,
            }, ct);
        }
        catch
        {
            await ClearPendingAsync(conn, ct);
            return new GmailConnectResult(false, null, "exchange_failed");
        }

        // Granular consent: the user can approve sign-in but untick Gmail. Without the Gmail scope the
        // grant is useless — treat as a denial and revoke the just-issued token so nothing lingers.
        var grantedScopes = token.Scope ?? "";
        if (!grantedScopes.Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(GmailScope))
        {
            if (!string.IsNullOrWhiteSpace(token.AccessToken)) await RevokeAtGoogleAsync(token.AccessToken!, ct);
            await ClearPendingAsync(conn, ct);
            return new GmailConnectResult(false, null, "scope_missing");
        }

        // prompt=consent should always yield a refresh token; without one the connection would die
        // within the hour, so refuse to store a half-connection.
        if (string.IsNullOrWhiteSpace(token.AccessToken) || string.IsNullOrWhiteSpace(token.RefreshToken))
        {
            await ClearPendingAsync(conn, ct);
            return new GmailConnectResult(false, null, "no_refresh_token");
        }

        var claims = DecodeJwtPayload(token.IdToken ?? "");
        var email = StrClaim(claims, "email");
        var sub = StrClaim(claims, "sub");

        // Reconnecting a DIFFERENT Gmail account: the synced mail belongs to the old account — purge it
        // and restart the initial sync. Same account keeps its store and resumes incrementally.
        if (!string.IsNullOrEmpty(conn.GmailSub) && !string.IsNullOrEmpty(sub) && conn.GmailSub != sub)
        {
            await _db.GmailMessages.Where(m => m.EndUserId == endUserId).ExecuteDeleteAsync(ct);
            conn.LastHistoryId = null;
            conn.InitialSyncDone = false;
        }

        conn.AccessTokenEncrypted = _protector.Protect(token.AccessToken!);
        conn.RefreshTokenEncrypted = _protector.Protect(token.RefreshToken!);
        conn.AccessTokenExpiresAt = DateTimeOffset.UtcNow.AddSeconds(token.ExpiresIn is > 0 ? token.ExpiresIn.Value : 3600);
        if (!string.IsNullOrWhiteSpace(email)) conn.GmailEmail = email;
        if (!string.IsNullOrWhiteSpace(sub)) conn.GmailSub = sub;
        conn.GrantedScopes = grantedScopes.Length > 512 ? grantedScopes[..512] : grantedScopes;
        conn.Status = "connected";
        conn.ConnectedAt = DateTimeOffset.UtcNow;
        conn.LastSyncError = null;
        conn.PendingState = null;
        conn.PendingCodeVerifier = null;
        conn.PendingCreatedAt = null;
        conn.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        return new GmailConnectResult(true, conn.GmailEmail, null);
    }

    public async Task<GmailStatusDto> GetStatusAsync(int endUserId, CancellationToken ct)
    {
        var available = await IsAvailableAsync(ct);
        var conn = await _db.GmailConnections.AsNoTracking().FirstOrDefaultAsync(c => c.EndUserId == endUserId, ct);
        var connected = IsConnected(conn);
        return new GmailStatusDto(
            available,
            available && connected,
            connected ? conn!.GmailEmail : null,
            connected ? conn!.ConnectedAt : null,
            connected && conn!.InitialSyncDone,
            connected ? conn!.LastSyncAt : null,
            NeedsReconnect: conn is { Status: "revoked" });
    }

    public async Task<string> TryGetValidAccessTokenAsync(int endUserId, CancellationToken ct)
    {
        var conn = await _db.GmailConnections.AsNoTracking().FirstOrDefaultAsync(c => c.EndUserId == endUserId, ct);
        if (!IsConnected(conn)) return "";

        var expiring = conn!.AccessTokenExpiresAt is null
            || conn.AccessTokenExpiresAt - DateTimeOffset.UtcNow <= RefreshSkew;
        if (expiring)
        {
            var refreshed = await RefreshAsync(endUserId, ct);
            // On a transient refresh failure fall back to the stored token: the Gmail call will 401
            // and the caller's one-shot ForceRefresh+retry surfaces the true error.
            return string.IsNullOrEmpty(refreshed) ? Unprotect(conn.AccessTokenEncrypted) : refreshed;
        }

        return Unprotect(conn.AccessTokenEncrypted);
    }

    public Task<string> ForceRefreshAsync(int endUserId, CancellationToken ct) =>
        RefreshAsync(endUserId, ct, force: true);

    public async Task DisconnectAsync(int endUserId, CancellationToken ct)
    {
        var conn = await _db.GmailConnections.FirstOrDefaultAsync(c => c.EndUserId == endUserId, ct);
        if (conn is not null)
        {
            // Revoking the refresh token kills the whole grant at Google. Best-effort: an already-
            // revoked token 400s, which must not block the local cleanup.
            var refreshToken = Unprotect(conn.RefreshTokenEncrypted);
            if (!string.IsNullOrEmpty(refreshToken)) await RevokeAtGoogleAsync(refreshToken, ct);
            _db.GmailConnections.Remove(conn);
            await _db.SaveChangesAsync(ct);
        }
        await _db.GmailMessages.Where(m => m.EndUserId == endUserId).ExecuteDeleteAsync(ct);
    }

    // --- refresh ---

    private async Task<string> RefreshAsync(int endUserId, CancellationToken ct, bool force = false)
    {
        var gate = RefreshLocks.GetOrAdd(endUserId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var conn = await _db.GmailConnections.FirstOrDefaultAsync(c => c.EndUserId == endUserId, ct);
            if (conn is not null) await _db.Entry(conn).ReloadAsync(ct); // pick up a peer's refresh
            if (!IsConnected(conn)) return "";

            // Double-check: a peer may have refreshed while we waited on the lock.
            if (!force && conn!.AccessTokenExpiresAt is not null
                && conn.AccessTokenExpiresAt - DateTimeOffset.UtcNow > RefreshSkew)
                return Unprotect(conn.AccessTokenEncrypted);

            string refreshToken;
            try { refreshToken = _protector.Unprotect(conn!.RefreshTokenEncrypted); }
            catch { return ""; }

            var creds = await GetClientCredentialsAsync(ct);
            if (creds is null) return "";

            GoogleTokenResponse token;
            try
            {
                token = await PostTokenAsync(new Dictionary<string, string>
                {
                    ["grant_type"] = "refresh_token",
                    ["refresh_token"] = refreshToken,
                    ["client_id"] = creds.Value.ClientId,
                    ["client_secret"] = creds.Value.ClientSecret,
                }, ct);
            }
            catch (GoogleTokenException ex) when (ex.ErrorCode == "invalid_grant")
            {
                // The grant is dead at Google: user revoked it, changed their password, or the 7-day
                // Testing-mode refresh-token expiry hit. Routine — mark revoked so the chat offers a
                // reconnect; keep GmailEmail/messages so the reconnect UX can name the account.
                conn.AccessTokenEncrypted = "";
                conn.RefreshTokenEncrypted = "";
                conn.AccessTokenExpiresAt = null;
                conn.Status = "revoked";
                conn.UpdatedAt = DateTimeOffset.UtcNow;
                try { await _db.SaveChangesAsync(ct); } catch { /* surfaced on the next attempt */ }
                return "";
            }
            catch
            {
                return ""; // transient (network/5xx): keep tokens, retry later
            }

            if (string.IsNullOrWhiteSpace(token.AccessToken)) return "";
            conn.AccessTokenEncrypted = _protector.Protect(token.AccessToken!);
            // Google normally omits refresh_token on refresh — keep the old one unless a new one came.
            if (!string.IsNullOrWhiteSpace(token.RefreshToken))
                conn.RefreshTokenEncrypted = _protector.Protect(token.RefreshToken!);
            conn.AccessTokenExpiresAt = DateTimeOffset.UtcNow.AddSeconds(token.ExpiresIn is > 0 ? token.ExpiresIn.Value : 3600);
            conn.UpdatedAt = DateTimeOffset.UtcNow;
            var newAccess = token.AccessToken!;
            try { await _db.SaveChangesAsync(ct); } catch { /* still return the fresh token for THIS call */ }
            return newAccess;
        }
        finally
        {
            gate.Release();
        }
    }

    // --- Google endpoints ---

    private sealed class GoogleTokenException : Exception
    {
        public string ErrorCode { get; }
        public GoogleTokenException(string errorCode, string message) : base(message) => ErrorCode = errorCode;
    }

    private record GoogleTokenResponse(string? AccessToken, string? RefreshToken, string? IdToken, string? Scope, int? ExpiresIn);

    private async Task<GoogleTokenResponse> PostTokenAsync(Dictionary<string, string> form, CancellationToken ct)
    {
        var client = _http.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, TokenEndpoint)
        {
            Content = new FormUrlEncodedContent(form),
        };
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            var (error, desc) = ExtractError(body);
            throw new GoogleTokenException(error, $"Google token request failed (HTTP {(int)res.StatusCode}). {desc}");
        }

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        return new GoogleTokenResponse(
            Str(root, "access_token"),
            Str(root, "refresh_token"),
            Str(root, "id_token"),
            Str(root, "scope"),
            root.TryGetProperty("expires_in", out var e) && e.TryGetInt32(out var n) ? n : null);
    }

    private async Task RevokeAtGoogleAsync(string token, CancellationToken ct)
    {
        try
        {
            var client = _http.CreateClient();
            using var req = new HttpRequestMessage(HttpMethod.Post, RevokeEndpoint)
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["token"] = token }),
            };
            using var res = await client.SendAsync(req, ct);
            // 200 = revoked, 400 = already invalid — both fine; never let revoke block cleanup.
        }
        catch { /* best-effort */ }
    }

    // --- helpers ---

    private async Task<(string ClientId, string ClientSecret)?> GetClientCredentialsAsync(CancellationToken ct)
    {
        var cfg = await _db.GoogleAuthConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
        if (cfg is null || !cfg.Enabled || string.IsNullOrWhiteSpace(cfg.ClientId)
            || string.IsNullOrEmpty(cfg.ClientSecretEncrypted))
            return null;
        try
        {
            var secret = _googleSecretProtector.Unprotect(cfg.ClientSecretEncrypted);
            return string.IsNullOrWhiteSpace(secret) ? null : (cfg.ClientId, secret);
        }
        catch
        {
            return null;
        }
    }

    private async Task<GmailConnection> GetOrCreateAsync(int endUserId, CancellationToken ct)
    {
        var conn = await _db.GmailConnections.FirstOrDefaultAsync(c => c.EndUserId == endUserId, ct);
        if (conn is null)
        {
            conn = new GmailConnection { EndUserId = endUserId };
            _db.GmailConnections.Add(conn);
        }
        return conn;
    }

    private async Task ClearPendingAsync(GmailConnection conn, CancellationToken ct)
    {
        conn.PendingState = null;
        conn.PendingCodeVerifier = null;
        conn.PendingCreatedAt = null;
        conn.UpdatedAt = DateTimeOffset.UtcNow;
        try { await _db.SaveChangesAsync(ct); } catch { /* best-effort */ }
    }

    private static bool IsConnected(GmailConnection? conn) =>
        conn is { Status: "connected" } && conn.ConnectedAt is not null
        && !string.IsNullOrEmpty(conn.RefreshTokenEncrypted);

    private string Unprotect(string cipher)
    {
        try { return _protector.Unprotect(cipher); } catch { return ""; }
    }

    // id_token payload decode only, no signature check — received over TLS directly from Google's
    // token endpoint (same rationale as OpenAiOAuthService.DecodeJwtPayload).
    private static JsonElement DecodeJwtPayload(string jwt)
    {
        var parts = jwt.Split('.');
        if (parts.Length < 2) return default;
        try
        {
            var json = Encoding.UTF8.GetString(Base64UrlDecode(parts[1]));
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.Clone();
        }
        catch { return default; }
    }

    private static string? StrClaim(JsonElement claims, string name) =>
        claims.ValueKind == JsonValueKind.Object ? Str(claims, name) : null;

    private static bool FixedTimeEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static (string Error, string Description) ExtractError(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return ("unknown", "(empty response)");
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var error = Str(root, "error") ?? "unknown";
            var desc = Str(root, "error_description") ?? error;
            return (error, desc);
        }
        catch
        {
            return ("unknown", body.Length > 500 ? body[..500] + "…" : body);
        }
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string s)
    {
        var t = s.Replace('-', '+').Replace('_', '/');
        switch (t.Length % 4) { case 2: t += "=="; break; case 3: t += "="; break; }
        return Convert.FromBase64String(t);
    }
}
