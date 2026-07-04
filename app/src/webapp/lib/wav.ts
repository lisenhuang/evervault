// PCM16 → WAV helpers. The TTS proxy returns raw base64 PCM16; expo-audio plays files/URIs, so we wrap
// the PCM in a WAV header and write a temp file. Includes self-contained base64 <-> bytes (Hermes has no
// guaranteed atob/btoa).

import * as FileSystem from "expo-file-system/legacy";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array(((len * 3) >> 2) - pad);
  const lut = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) lut[B64.charCodeAt(i)] = i;
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lut[clean.charCodeAt(i)];
    const b = lut[clean.charCodeAt(i + 1)];
    const c = lut[clean.charCodeAt(i + 2)];
    const d = lut[clean.charCodeAt(i + 3)];
    const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
    if (o < out.length) out[o++] = (chunk >> 16) & 0xff;
    if (o < out.length) out[o++] = (chunk >> 8) & 0xff;
    if (o < out.length) out[o++] = chunk & 0xff;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

/** Build a 16-bit mono WAV (44-byte header + PCM) from raw little-endian PCM16 bytes. */
export function buildWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const dataLen = pcm.length;
  const buf = new Uint8Array(44 + dataLen);
  const view = new DataView(buf.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 2 bytes/sample)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);
  buf.set(pcm, 44);
  return buf;
}

let counter = 0;

/** Write a WAV temp file from base64 PCM16 and return its file uri. */
export async function writePcmWavFile(pcmBase64: string, sampleRate: number): Promise<string> {
  const wav = buildWav(base64ToBytes(pcmBase64), sampleRate);
  const uri = `${FileSystem.cacheDirectory}tts-${Date.now()}-${counter++}.wav`;
  await FileSystem.writeAsStringAsync(uri, bytesToBase64(wav), { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}
