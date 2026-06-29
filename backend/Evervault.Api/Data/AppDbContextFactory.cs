using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Pgvector.EntityFrameworkCore;

namespace Evervault.Api.Data;

/// <summary>
/// Design-time factory so `dotnet ef migrations add` works offline (no live DB needed).
/// The connection string is a placeholder; migrations only need the model.
/// </summary>
public class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(
                "Host=localhost;Port=5432;Database=evervault;Username=postgres",
                o => o.UseVector())
            .Options;
        return new AppDbContext(options);
    }
}
