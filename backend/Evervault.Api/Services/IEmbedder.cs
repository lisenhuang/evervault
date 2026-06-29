namespace Evervault.Api.Services;

/// <summary>Turns text into a fixed-length embedding vector.</summary>
public interface IEmbedder
{
    int Dimensions { get; }
    float[] Embed(string text);
}
