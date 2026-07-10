using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Evervault.Api.Data;
using Evervault.Api.Models;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Evervault.Api.Services;

/// <summary>
/// Implements the Codex "Sign in with ChatGPT" OAuth flow (PKCE) and stores the resulting tokens
/// ENCRYPTED (Data Protection) in a single-row table — same shape as <see cref="GoogleAuthService"/>.
/// The <c>redirect_uri</c> is locked by OpenAI to <c>http://localhost:1455</c> (Codex's loopback), which
/// a hosted panel can't receive, so login is: open the authorize URL, sign in, then paste the redirected
/// URL back — we exchange the code server-side. Access tokens are short-lived and refresh tokens ROTATE,
/// so refresh is serialized (static semaphore) and double-checked to avoid persisting a dead token.
/// </summary>
public class OpenAiOAuthService : IOpenAiOAuthService
{
    // Public Codex CLI client — the only client OpenAI's ChatGPT-subscription OAuth accepts.
    private const string ClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
    private const string AuthorizeEndpoint = "https://auth.openai.com/oauth/authorize";
    private const string TokenEndpoint = "https://auth.openai.com/oauth/token";
    private const string RedirectUri = "http://localhost:1455/auth/callback";
    private const string Scope = "openid profile email offline_access";

    // Refresh a bit before the real expiry so a turn never starts on an about-to-die token.
    private static readonly TimeSpan RefreshSkew = TimeSpan.FromSeconds(120);
    // A pending authorization older than this is stale (auth codes expire fast).
    private static readonly TimeSpan PendingTtl = TimeSpan.FromMinutes(10);

    // Refresh-token rotation is process-serialized: two concurrent turns must not both POST the same
    // (single-use) refresh token, or one 400s invalid_grant and a last-writer-wins save kills the login.
    private static readonly SemaphoreSlim RefreshLock = new(1, 1);

    private readonly AppDbContext _db;
    private readonly IDataProtector _protector;
    private readonly IHttpClientFactory _http;

    public OpenAiOAuthService(AppDbContext db, IDataProtectionProvider dp, IHttpClientFactory http)
    {
        _db = db;
        _protector = dp.CreateProtector("Evervault.OpenAiOAuth");
        _http = http;
    }

    public async Task<string> BuildAuthorizeUrlAsync(CancellationToken ct)
    {
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(64));
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var state = Base64Url(RandomNumberGenerator.GetBytes(32));

        var cfg = await GetOrCreateAsync(ct);
        cfg.PendingState = state;
        cfg.PendingCodeVerifier = verifier;
        cfg.PendingCreatedAt = DateTimeOffset.UtcNow;
        cfg.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        var q = new Dictionary<string, string>
        {
            ["response_type"] = "code",
            ["client_id"] = ClientId,
            ["redirect_uri"] = RedirectUri,
            ["scope"] = Scope,
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256",
            ["state"] = state,
            // OpenAI-specific: makes the id_token carry the chatgpt_account_id claim we need for the
            // chatgpt-account-id header, and selects Codex's simplified consent screen.
            ["id_token_add_organizations"] = "true",
            ["codex_cli_simplified_flow"] = "true",
            ["originator"] = "codex_cli_rs",
        };
        return AuthorizeEndpoint + "?" + string.Join("&",
            q.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
    }

    public async Task<OpenAiOAuthStatusDto> CompleteAsync(string redirectUrlOrCode, CancellationToken ct)
    {
        var (code, state) = ParseCodeAndState(redirectUrlOrCode);
        if (string.IsNullOrWhiteSpace(code))
            throw new InvalidOperationException("Couldn't find a login code in what you pasted. Paste the full redirected URL from the browser address bar.");

        var cfg = await GetOrCreateAsync(ct);
        if (string.IsNullOrWhiteSpace(cfg.PendingCodeVerifier) || string.IsNullOrWhiteSpace(cfg.PendingState))
            throw new InvalidOperationException("No login is in progress. Click Connect to start again.");
        if (cfg.PendingCreatedAt is null || DateTimeOffset.UtcNow - cfg.PendingCreatedAt > PendingTtl)
            throw new InvalidOperationException("This login expired. Click Connect to start again.");
        // state guards CSRF; only enforced when the pasted value actually carried one.
        if (!string.IsNullOrWhiteSpace(state) && !FixedTimeEquals(state, cfg.PendingState))
            throw new InvalidOperationException("The login state didn't match. Click Connect and try again.");

        var form = new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = RedirectUri,
            ["client_id"] = ClientId,
            ["code_verifier"] = cfg.PendingCodeVerifier!,
        };
        var token = await PostTokenAsync(form, ct);

        StoreTokens(cfg, token, requireIdentity: true);
        cfg.PendingState = null;
        cfg.PendingCodeVerifier = null;
        cfg.PendingCreatedAt = null;
        cfg.ConnectedAt = DateTimeOffset.UtcNow;
        cfg.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);

        return ToStatus(cfg);
    }

    public async Task<OpenAiOAuthStatusDto> GetStatusAsync(CancellationToken ct)
    {
        var cfg = await _db.OpenAiOAuthConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
        return cfg is null ? new OpenAiOAuthStatusDto(false, null, null, null) : ToStatus(cfg);
    }

    public async Task DisconnectAsync(CancellationToken ct)
    {
        var cfg = await _db.OpenAiOAuthConfigs.FirstOrDefaultAsync(ct);
        if (cfg is null) return;
        cfg.AccessTokenEncrypted = "";
        cfg.RefreshTokenEncrypted = "";
        cfg.AccountId = "";
        cfg.AccessTokenExpiresAt = null;
        cfg.ConnectedEmail = null;
        cfg.ConnectedAt = null;
        cfg.PendingState = null;
        cfg.PendingCodeVerifier = null;
        cfg.PendingCreatedAt = null;
        cfg.UpdatedAt = DateTimeOffset.UtcNow;
        await _db.SaveChangesAsync(ct);
    }

    public async Task<string> TryGetValidAccessTokenAsync(CancellationToken ct)
    {
        var cfg = await _db.OpenAiOAuthConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
        if (!IsConnected(cfg)) return "";

        var expiring = cfg!.AccessTokenExpiresAt is null
            || cfg.AccessTokenExpiresAt - DateTimeOffset.UtcNow <= RefreshSkew;
        if (expiring)
        {
            var refreshed = await RefreshAsync(ct);
            // If a proactive refresh fails transiently, fall back to the stored token: the real call will
            // 401 and the failover runner's one-shot ForceRefresh+retry surfaces the true error.
            return string.IsNullOrEmpty(refreshed) ? Unprotect(cfg.AccessTokenEncrypted) : refreshed;
        }

        return Unprotect(cfg.AccessTokenEncrypted);
    }

    public async Task<string> GetAccountIdAsync(CancellationToken ct)
    {
        var cfg = await _db.OpenAiOAuthConfigs.AsNoTracking().FirstOrDefaultAsync(ct);
        return IsConnected(cfg) ? cfg!.AccountId : "";
    }

    public Task<string> ForceRefreshAsync(CancellationToken ct) => RefreshAsync(ct, force: true);

    // --- refresh (rotation-safe) ---

    private async Task<string> RefreshAsync(CancellationToken ct, bool force = false)
    {
        await RefreshLock.WaitAsync(ct);
        try
        {
            var cfg = await _db.OpenAiOAuthConfigs.FirstOrDefaultAsync(ct);
            if (cfg is not null) await _db.Entry(cfg).ReloadAsync(ct); // pick up a refresh a peer just committed
            if (!IsConnected(cfg)) return "";

            // Double-check: a peer may have refreshed while we waited on the lock.
            if (!force && cfg!.AccessTokenExpiresAt is not null
                && cfg.AccessTokenExpiresAt - DateTimeOffset.UtcNow > RefreshSkew)
                return Unprotect(cfg.AccessTokenEncrypted);

            string refreshToken;
            try { refreshToken = _protector.Unprotect(cfg!.RefreshTokenEncrypted); }
            catch { return ""; }

            var form = new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = refreshToken,
                ["client_id"] = ClientId,
                ["scope"] = Scope,
            };

            OpenAiTokenResponse token;
            try
            {
                token = await PostTokenAsync(form, ct);
            }
            catch
            {
                // The refresh token is single-use and ROTATES. During an overlapping deploy another
                // instance may have consumed it and saved a new one, so our POST 400s (invalid_grant).
                // Reload committed state: if a peer already rotated/refreshed, reuse THEIR token instead
                // of blanking ours (which would brick the connection until a human re-auths).
                await _db.Entry(cfg).ReloadAsync(ct);
                if (IsConnected(cfg))
                {
                    var current = Unprotect(cfg.RefreshTokenEncrypted);
                    var stillValid = cfg.AccessTokenExpiresAt is not null
                        && cfg.AccessTokenExpiresAt - DateTimeOffset.UtcNow > RefreshSkew;
                    if (stillValid || (!string.IsNullOrEmpty(current) && current != refreshToken))
                        return Unprotect(cfg.AccessTokenEncrypted);
                }
                return "";
            }

            StoreTokens(cfg, token, requireIdentity: false);
            cfg.UpdatedAt = DateTimeOffset.UtcNow;
            var newAccess = Unprotect(cfg.AccessTokenEncrypted);
            // We've already consumed the old refresh token upstream; if persisting the rotated pair
            // fails, still return the new access token so THIS turn succeeds (best effort).
            try { await _db.SaveChangesAsync(ct); } catch { /* surfaced on the next refresh */ }
            return newAccess;
        }
        finally
        {
            RefreshLock.Release();
        }
    }

    // --- token endpoint ---

    private record OpenAiTokenResponse(string? AccessToken, string? RefreshToken, string? IdToken, int? ExpiresIn);

    private async Task<OpenAiTokenResponse> PostTokenAsync(Dictionary<string, string> form, CancellationToken ct)
    {
        var client = _http.CreateClient();
        using var req = new HttpRequestMessage(HttpMethod.Post, TokenEndpoint)
        {
            Content = new FormUrlEncodedContent(form),
        };
        using var res = await client.SendAsync(req, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException($"OpenAI token request failed (HTTP {(int)res.StatusCode}). {ExtractError(body)}");

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        return new OpenAiTokenResponse(
            Str(root, "access_token"),
            Str(root, "refresh_token"),
            Str(root, "id_token"),
            root.TryGetProperty("expires_in", out var e) && e.TryGetInt32(out var n) ? n : null);
    }

    /// <summary>Persist a token response. On the initial exchange we require the identity (account id);
    /// on refresh the id_token may be absent, so we keep the existing account id/email.</summary>
    private void StoreTokens(OpenAiOAuthConfig cfg, OpenAiTokenResponse token, bool requireIdentity)
    {
        if (string.IsNullOrWhiteSpace(token.AccessToken))
            throw new InvalidOperationException("OpenAI did not return an access token.");

        cfg.AccessTokenEncrypted = _protector.Protect(token.AccessToken);
        if (!string.IsNullOrWhiteSpace(token.RefreshToken))
            cfg.RefreshTokenEncrypted = _protector.Protect(token.RefreshToken); // rotation: replace old
        cfg.AccessTokenExpiresAt = DateTimeOffset.UtcNow.AddSeconds(token.ExpiresIn is > 0 ? token.ExpiresIn.Value : 3600);

        if (!string.IsNullOrWhiteSpace(token.IdToken))
        {
            var claims = DecodeJwtPayload(token.IdToken!);
            var accountId = ExtractAccountId(claims);
            var email = ExtractEmail(claims);
            if (!string.IsNullOrWhiteSpace(accountId)) cfg.AccountId = accountId!;
            if (!string.IsNullOrWhiteSpace(email)) cfg.ConnectedEmail = email;
        }

        if (requireIdentity && string.IsNullOrWhiteSpace(cfg.AccountId))
            throw new InvalidOperationException(
                "Signed in, but no ChatGPT account id was found in the token. This usually means the account has no Codex/API access — a paid ChatGPT plan is required.");
    }

    // --- id_token (JWT) decoding: payload only, no signature check (received over TLS from the token endpoint) ---

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

    private static string? ExtractAccountId(JsonElement claims)
    {
        if (claims.ValueKind != JsonValueKind.Object) return null;
        if (claims.TryGetProperty("chatgpt_account_id", out var top) && top.ValueKind == JsonValueKind.String)
            return top.GetString();
        if (claims.TryGetProperty("https://api.openai.com/auth", out var auth) && auth.ValueKind == JsonValueKind.Object)
        {
            if (auth.TryGetProperty("chatgpt_account_id", out var a) && a.ValueKind == JsonValueKind.String)
                return a.GetString();
            if (auth.TryGetProperty("organizations", out var orgs) && orgs.ValueKind == JsonValueKind.Array && orgs.GetArrayLength() > 0)
            {
                var first = orgs[0];
                if (first.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String) return id.GetString();
            }
        }
        return null;
    }

    private static string? ExtractEmail(JsonElement claims)
    {
        if (claims.ValueKind != JsonValueKind.Object) return null;
        return claims.TryGetProperty("email", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
    }

    // --- helpers ---

    private async Task<OpenAiOAuthConfig> GetOrCreateAsync(CancellationToken ct)
    {
        var cfg = await _db.OpenAiOAuthConfigs.FirstOrDefaultAsync(ct);
        if (cfg is null)
        {
            cfg = new OpenAiOAuthConfig();
            _db.OpenAiOAuthConfigs.Add(cfg);
        }
        return cfg;
    }

    private static bool IsConnected(OpenAiOAuthConfig? cfg) =>
        cfg is not null && cfg.ConnectedAt is not null && !string.IsNullOrEmpty(cfg.AccessTokenEncrypted);

    private static OpenAiOAuthStatusDto ToStatus(OpenAiOAuthConfig cfg) =>
        IsConnected(cfg)
            ? new OpenAiOAuthStatusDto(true, cfg.ConnectedEmail, cfg.ConnectedAt, cfg.AccessTokenExpiresAt)
            : new OpenAiOAuthStatusDto(false, null, null, null);

    private string Unprotect(string cipher)
    {
        try { return _protector.Unprotect(cipher); } catch { return ""; }
    }

    private static (string? Code, string? State) ParseCodeAndState(string input)
    {
        input = (input ?? "").Trim();
        if (input.Length == 0) return (null, null);

        // Accept a full URL, a bare "code=..&state=.." querystring, or just the code.
        var query = input;
        var qIdx = input.IndexOf('?');
        if (qIdx >= 0) query = input[(qIdx + 1)..];
        if (!query.Contains('=')) return (input, null); // looks like a bare code

        string? code = null, state = null;
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            if (eq < 0) continue;
            var key = pair[..eq];
            var val = Uri.UnescapeDataString(pair[(eq + 1)..]);
            if (key == "code") code = val;
            else if (key == "state") state = val;
        }
        return (code, state);
    }

    private static bool FixedTimeEquals(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string ExtractError(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "(empty response)";
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var desc = Str(root, "error_description") ?? Str(root, "error");
            if (!string.IsNullOrWhiteSpace(desc)) return desc!;
        }
        catch { /* not JSON */ }
        return body.Length > 500 ? body[..500] + "…" : body;
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
