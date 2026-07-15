namespace Evervault.Api.Models;

/// <summary>
/// One piece of product feedback an end user chose to send to the developers from the /webapp chat.
/// The AI only records this after the user explicitly agrees to pass their idea along; the row is the
/// admin-facing record read back in /admin/suggestions. Any screenshots the user shared alongside the
/// suggestion are uploaded to R2 and referenced by <see cref="SuggestionImage"/> rows.
/// <see cref="EndUserId"/> is a bare id (no navigation, matching <see cref="ErrorReport"/>): feedback is
/// deliberately kept even if the account is later deleted, so it is not cascade-removed with the user.
/// </summary>
public class Suggestion
{
    public int Id { get; set; }
    public int? EndUserId { get; set; }
    public string? UserEmail { get; set; }                 // snapshot of the submitter's email, so the admin can see who sent it
    public string Category { get; set; } = "other";        // feature | bug | praise | complaint | other
    public string Summary { get; set; } = string.Empty;    // short one-line title for the admin list (AI-written)
    public string Details { get; set; } = string.Empty;    // the full suggestion, in the user's own words
    public string Status { get; set; } = "new";            // new | reviewed | archived — admin triage state
    public string? UserAgent { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public List<SuggestionImage> Images { get; set; } = new();
}

/// <summary>
/// One screenshot/image attached to a <see cref="Suggestion"/>. The bytes live in R2 under
/// <see cref="ObjectKey"/>; the admin views them through a presigned-URL redirect. Cascade-deleted
/// with its parent suggestion.
/// </summary>
public class SuggestionImage
{
    public int Id { get; set; }
    public int SuggestionId { get; set; }
    public string ObjectKey { get; set; } = string.Empty;  // R2 key, e.g. "suggestion-images/{uid}/{suggestionId}/{n}.jpg"
    public string Mime { get; set; } = "image/jpeg";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public Suggestion? Suggestion { get; set; }
}
