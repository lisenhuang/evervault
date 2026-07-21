using System.Text;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// Splits a reply into sentence-sized chunks for progressive text-to-speech: the caller synthesizes and
/// streams each chunk on its own, so playback of the first sentence can start while the rest is still being
/// generated. Chunks break on sentence-ending punctuation (and blank-line paragraph breaks), coalescing
/// fragments shorter than <c>minChars</c> so a stray "Hi." isn't synthesized on its own (an extra, choppy
/// TTS call), and hard-splitting on whitespace once a run passes <c>maxChars</c> so no single chunk is huge.
/// Purely heuristic — the occasional split mid-abbreviation only adds a tiny pause — and never drops text:
/// concatenating the chunks reproduces the input's characters (whitespace between chunks aside).
/// </summary>
public static class SentenceChunker
{
    private const int DefaultMinChars = 45;   // below this, keep accumulating rather than emit a stub
    private const int DefaultMaxChars = 220;  // above this, break at the next space even mid-sentence

    public static List<string> Split(string text, int minChars = DefaultMinChars, int maxChars = DefaultMaxChars)
    {
        var chunks = new List<string>();
        if (string.IsNullOrWhiteSpace(text)) return chunks;

        var s = text.Replace("\r\n", "\n").Replace('\r', '\n');
        var sb = new StringBuilder();

        void Flush()
        {
            var chunk = sb.ToString().Trim();
            if (chunk.Length > 0) chunks.Add(chunk);
            sb.Clear();
        }

        for (int i = 0; i < s.Length; i++)
        {
            char ch = s[i];
            sb.Append(ch);
            char? next = i + 1 < s.Length ? s[i + 1] : null;

            // Sentence end: terminal punctuation at end-of-text or before whitespace. A '.' sitting between
            // two digits (e.g. "3.14") is a decimal point, not a sentence break.
            bool decimalDot = ch == '.' && i > 0 && char.IsDigit(s[i - 1]) && next is not null && char.IsDigit(next.Value);
            bool sentenceEnd =
                ch is '.' or '!' or '?' or '…' or '。' or '！' or '？'
                && (next is null || char.IsWhiteSpace(next.Value))
                && !decimalDot;
            bool paragraphEnd = ch == '\n' && next == '\n';

            int len = TrimmedLength(sb);
            if ((sentenceEnd || paragraphEnd) && len >= minChars)
                Flush();
            else if (len >= maxChars && char.IsWhiteSpace(ch))
                Flush();
        }
        Flush(); // the trailing run (no terminal punctuation, or shorter than minChars)
        return chunks;
    }

    // Length of the buffer ignoring leading/trailing whitespace, without allocating a trimmed copy.
    private static int TrimmedLength(StringBuilder sb)
    {
        int start = 0, end = sb.Length - 1;
        while (start <= end && char.IsWhiteSpace(sb[start])) start++;
        while (end >= start && char.IsWhiteSpace(sb[end])) end--;
        return end - start + 1;
    }
}
