namespace Evervault.Api.Models;

/// <summary>An admin account. Created once via the /admin first-run setup flow.</summary>
public class AdminUser
{
    public int Id { get; set; }
    public string Email { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>Google "sub" of a bound Google account (null = not linked). Filtered-unique index.</summary>
    public string? GoogleSub { get; set; }
    /// <summary>The bound Google account's email (display only).</summary>
    public string? GoogleEmail { get; set; }
}
