// Play a spoken reply clip (base64 PCM16 from the TTS proxy) through expo-audio. We wrap the PCM in a
// WAV temp file and play the file. Returns a handle so the caller can stop it and await its end.

import { createAudioPlayer, setAudioModeAsync } from "expo-audio";

import { writePcmWavFile } from "./wav";

export type ClipHandle = { stop: () => void; ended: Promise<void> };

export async function playPcm16(pcmBase64: string, sampleRate: number): Promise<ClipHandle> {
  const uri = await writePcmWavFile(pcmBase64, sampleRate);
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
  } catch {
    /* fall through — playback may still work */
  }

  const player = createAudioPlayer({ uri });
  let done = false;
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((r) => (resolveEnded = r));

  const sub = player.addListener("playbackStatusUpdate", (status: { didJustFinish?: boolean }) => {
    if (status.didJustFinish) cleanup();
  });

  function cleanup() {
    if (done) return;
    done = true;
    try {
      sub.remove();
    } catch {
      /* ignore */
    }
    try {
      player.remove();
    } catch {
      /* ignore */
    }
    resolveEnded();
  }

  player.play();
  return { stop: cleanup, ended };
}
