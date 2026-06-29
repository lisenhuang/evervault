namespace Evervault.Api.Models;

/// <summary>An admin account. Created once via the /admin first-run setup flow.</summary>
public class AdminUser
{
    public int Id { get; set; }
    public string Email { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
