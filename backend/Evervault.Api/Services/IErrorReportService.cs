namespace Evervault.Api.Services;

/// <summary>
/// Persists <see cref="Models.ErrorReport"/> rows and mints the short reference codes end users see.
/// Capture never throws — an error report must never break the failing response path it is called from.
/// </summary>
public interface IErrorReportService
{
    /// <summary>A fresh "EV-XXXXXXXX" reference code.</summary>
    string NewCode();

    /// <summary>
    /// Records one failure and returns its reference code. Pass <paramref name="code"/> to reuse a
    /// client-generated code (idempotent: an already-stored code is a no-op); otherwise a new one is
    /// minted. Fields are clipped to their column limits; the whole call is best-effort.
    /// </summary>
    Task<string> CaptureAsync(
        string source, string area, int? endUserId, int? httpStatus,
        string message, string? detail, string? userAgent = null, string? code = null);
}
