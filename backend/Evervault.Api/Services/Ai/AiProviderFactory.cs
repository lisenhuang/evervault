namespace Evervault.Api.Services.Ai;

/// <summary>Resolves the right provider by name. When <c>AI_FAKE=1</c> is set, every provider is the
/// offline <see cref="FakeAiProvider"/> so the feature works end-to-end without real keys.</summary>
public class AiProviderFactory : IAiProviderFactory
{
    private readonly IServiceProvider _sp;
    private readonly bool _fake;

    public AiProviderFactory(IServiceProvider sp, IConfiguration config)
    {
        _sp = sp;
        _fake = config["AI_FAKE"] == "1" || Environment.GetEnvironmentVariable("AI_FAKE") == "1";
    }

    public bool IsFake => _fake;

    public IAiProvider Get(string provider)
    {
        var name = (provider ?? "").Trim().ToLowerInvariant();
        if (_fake) return new FakeAiProvider(name is "gemini" or "openrouter" or "openai" ? name : "openrouter");
        return name switch
        {
            "openrouter" => _sp.GetRequiredService<OpenRouterProvider>(),
            "gemini" => _sp.GetRequiredService<GeminiProvider>(),
            "openai" => _sp.GetRequiredService<OpenAiProvider>(),
            _ => throw new AiProviderException(AiErrorKind.Other, $"Unknown AI provider '{provider}'."),
        };
    }
}
