namespace Evervault.Api.Models;

/// <summary>
/// One captured failure, identified by the short reference code shown to the end user (e.g. "EV-7K2M9QX4").
/// Users only ever see a generic message plus this code; the raw detail (provider errors, gateway HTML)
/// lives here and is searchable by code in /admin/errors. Rows come from two sources: the backend's own
/// AI-failure sites, and browser reports for failures the backend never saw (origin down → Cloudflare 502).
/// </summary>
public class ErrorReport
{
    public int Id { get; set; }
    public string Code { get; set; } = string.Empty;     // "EV-XXXXXXXX", unique — the user-visible handle
    public string Source { get; set; } = "backend";      // backend | client
    public int? EndUserId { get; set; }
    public string Area { get; set; } = string.Empty;     // chat.send | chat.voice | call.start | live-token | voice-sample | ai-proxy
    public int? HttpStatus { get; set; }
    public string Message { get; set; } = string.Empty;  // short human-readable summary
    public string? Detail { get; set; }                  // raw body / masked provider errors — admin-only
    public string? UserAgent { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
