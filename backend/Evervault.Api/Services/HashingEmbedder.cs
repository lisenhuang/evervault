using System.Text;

namespace Evervault.Api.Services;

/// <summary>
/// PLACEHOLDER embedder: deterministic signed feature-hashing into a fixed-size, L2-normalized
/// vector. No external API or keys — enough to exercise pgvector end-to-end (overlapping tokens
/// → closer vectors). Replace with a real provider (OpenAI/Voyage/local model) later; keep
/// <see cref="Dimensions"/> in sync with the vector(N) column.
/// </summary>
public sealed class HashingEmbedder : IEmbedder
{
    public int Dimensions => 1536;

    public float[] Embed(string text)
    {
        var vec = new float[Dimensions];
        if (string.IsNullOrWhiteSpace(text)) return vec;

        foreach (var token in Tokenize(text))
        {
            var h = Fnv1a(token);
            var idx = (int)(h % (uint)Dimensions);
            var sign = (h & 1u) == 0 ? 1f : -1f; // signed hashing reduces collision bias
            vec[idx] += sign;
        }

        Normalize(vec);
        return vec;
    }

    private static IEnumerable<string> Tokenize(string text)
    {
        var sb = new StringBuilder();
        foreach (var ch in text.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(ch)) sb.Append(ch);
            else if (sb.Length > 0) { yield return sb.ToString(); sb.Clear(); }
        }
        if (sb.Length > 0) yield return sb.ToString();
    }

    private static uint Fnv1a(string s)
    {
        uint hash = 2166136261;
        foreach (var ch in s)
        {
            hash ^= ch;
            hash *= 16777619;
        }
        return hash;
    }

    private static void Normalize(float[] v)
    {
        double sum = 0;
        foreach (var x in v) sum += (double)x * x;
        if (sum <= 0) return;
        var norm = (float)Math.Sqrt(sum);
        for (var i = 0; i < v.Length; i++) v[i] /= norm;
    }
}
