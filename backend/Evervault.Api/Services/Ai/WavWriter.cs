using System.Text;

namespace Evervault.Api.Services.Ai;

/// <summary>
/// Wraps raw little-endian PCM signed-16-bit MONO audio (what Gemini TTS returns) in a canonical
/// 44-byte RIFF/WAVE header so browsers can play it directly. No external audio dependency.
/// </summary>
public static class WavWriter
{
    /// <summary>Build a complete WAV byte[] from raw mono PCM16 + sample rate (e.g. 24000).</summary>
    public static byte[] FromPcm16Mono(ReadOnlySpan<byte> pcm, int sampleRate)
    {
        const int channels = 1, bitsPerSample = 16;
        int byteRate = sampleRate * channels * bitsPerSample / 8;
        short blockAlign = (short)(channels * bitsPerSample / 8);
        int dataLen = pcm.Length;

        using var ms = new MemoryStream(44 + dataLen);
        using (var w = new BinaryWriter(ms, Encoding.ASCII, leaveOpen: true))
        {
            w.Write("RIFF"u8.ToArray());   // raw bytes (NOT w.Write(string), which length-prefixes)
            w.Write(36 + dataLen);         // ChunkSize
            w.Write("WAVE"u8.ToArray());
            w.Write("fmt "u8.ToArray());
            w.Write(16);                   // Subchunk1Size (PCM)
            w.Write((short)1);             // AudioFormat = PCM
            w.Write((short)channels);
            w.Write(sampleRate);
            w.Write(byteRate);
            w.Write(blockAlign);
            w.Write((short)bitsPerSample);
            w.Write("data"u8.ToArray());
            w.Write(dataLen);
        }
        ms.Write(pcm);
        return ms.ToArray();
    }

    /// <summary>Parse rate=NNNNN out of a Gemini mime like "audio/L16;codec=pcm;rate=24000". Defaults 24000.</summary>
    public static int SampleRateFromMime(string? mime)
    {
        if (!string.IsNullOrEmpty(mime))
            foreach (var part in mime.Split(';'))
            {
                var p = part.Trim();
                if (p.StartsWith("rate=", StringComparison.OrdinalIgnoreCase)
                    && int.TryParse(p.AsSpan(5), out var r) && r > 0)
                    return r;
            }
        return 24000;
    }
}
