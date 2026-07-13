using System.Globalization;

namespace Evervault.Api.Services;

/// <summary>
/// The visitor's IP + geolocation, read from Cloudflare edge request headers. <c>CF-Connecting-IP</c>
/// (real client IP) and <c>CF-IPCountry</c> arrive by default; the finer fields require Cloudflare's
/// "Add visitor location headers" managed transform to be enabled in the dashboard. Every field is
/// best-effort — <c>null</c> when its header is absent — so reads are safe before/after that toggle and
/// behind other proxies. Header lookups are case-insensitive.
/// </summary>
public readonly record struct CloudflareGeo(
    string? Ip,
    string? Country,
    string? City,
    string? Region,
    string? Continent,
    double? Latitude,
    double? Longitude,
    string? PostalCode,
    string? Timezone)
{
    public static CloudflareGeo From(HttpRequest req)
    {
        string? S(string name)
        {
            var v = req.Headers[name].ToString();
            return string.IsNullOrWhiteSpace(v) ? null : v.Trim();
        }
        double? D(string name) =>
            double.TryParse(S(name), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;

        // Prefer Cloudflare's real client IP; fall back to the connection's remote address behind other proxies.
        var ip = S("CF-Connecting-IP") ?? req.HttpContext.Connection.RemoteIpAddress?.ToString();

        return new CloudflareGeo(
            Ip: ip,
            Country: S("CF-IPCountry"),
            City: S("CF-IPCity"),
            Region: S("cf-region"),
            Continent: S("cf-ipcontinent"),
            Latitude: D("cf-iplatitude"),
            Longitude: D("cf-iplongitude"),
            PostalCode: S("cf-postal-code"),
            Timezone: S("cf-timezone"));
    }
}
