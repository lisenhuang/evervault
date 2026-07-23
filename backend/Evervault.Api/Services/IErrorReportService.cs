namespace Evervault.Api.Services;

/// <summary>Outcome of a capture: the reference code, and whether the row actually reached the DB.</summary>
/// <param name="Code">The "EV-XXXXXXXX" reference code (minted or reused).</param>
/// <param name="Persisted">
/// True when the report is durably stored (freshly inserted or already present). False when the DB
/// write failed and was swallowed — the code was still minted, but no row exists to look up.
/// </param>
public readonly record struct CaptureResult(string Code, bool Persisted);

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

    /// <summary>
    /// Like <see cref="CaptureAsync"/>, but also reports whether the row was durably stored. Callers that
    /// can retry (the client error-report queue) use <see cref="CaptureResult.Persisted"/> to decide
    /// whether to signal a retryable failure instead of a false success, so a shown code is never dropped
    /// on a transient DB write. Still never throws.
    /// </summary>
    Task<CaptureResult> TryCaptureAsync(
        string source, string area, int? endUserId, int? httpStatus,
        string message, string? detail, string? userAgent = null, string? code = null);
}
