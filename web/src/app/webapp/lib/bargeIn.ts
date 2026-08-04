// Lets the user interrupt the model BY SPEAKING on platforms where the mic has to stay gated while
// the speaker is sounding — i.e. iOS, where the system echo canceller can't see Web Audio output
// (see echoDetector.ts for that background).
//
// The bind. Gating the mic during the model's turn is what stops the model interrupting itself, but
// it also throws away the only evidence that the user has started talking, so barge-in dies with it.
// Ungating is not an option: the microphone genuinely cannot tell the user apart from the speaker,
// because on that path both arrive as plain sound.
//
// …except that we can make them tell themselves apart. We are the ones playing the audio, so we can
// stop it. Echo is by definition a copy of our own output: turn the output down and it disappears
// within milliseconds. The user's voice does not. So the microphone CAN answer the question, as long
// as we ask it at a moment when the speaker is quiet — and we control when that is.
//
// Hence two stages, cheap-then-certain:
//
//   1. TRIGGER (free, runs on every gated chunk). The mic rose well above what our own output could
//      plausibly be echoing back — "plausibly" being a coupling factor learned from this very call,
//      since how much of the speaker reaches the mic depends on the phone, the room and whether it's
//      face-up on a desk. A guess, and deliberately a jumpy one; it only has to be worth checking.
//   2. PROBE (~a quarter second, costs a dip in volume). Duck the output hard and listen again. Any
//      echo collapses with it; a voice doesn't. Still loud → the user is really talking, commit the
//      barge-in. Gone quiet → it was our own sound, fold that reading back into the coupling estimate
//      so the same false alarm doesn't repeat, and bring the volume back up.
//
// Every wrong answer is cheap and self-correcting. A false trigger costs a ~240 ms duck — a dip, not
// a cut, and the model keeps talking through it — and makes the next one less likely. A missed
// trigger costs nothing that isn't already lost today, since the alternative is no barge-in at all.
// And when the model happens to be silent (between sentences, or its turn already drained) there is
// no echo to rule out, so the probe is skipped and the interrupt is immediate.
//
// Deliberately not DSP: this never tries to REMOVE echo from the signal, only to arrange one moment
// where there isn't any. That's why it can be a few dozen lines of arithmetic on levels we already
// compute, instead of an adaptive filter that would have to track the room.

/** What the caller should do with the player right now. */
export type BargeAction =
  /** Nothing changed. */
  | "none"
  /** Attenuate output — a probe has begun. Keep feeding chunks; the verdict lands within ~240 ms. */
  | "duck"
  /** Probe over, it was our own echo: restore the volume and carry on. */
  | "resume"
  /** The user is genuinely speaking over the model: stop playback and start sending mic audio. */
  | "commit";

/** Consecutive chunks over the trigger threshold before a probe. One is a door slam; two is a voice. */
const TRIGGER_CHUNKS = 2;
/** How far over the *expected* echo level the mic must sit to be worth probing. ~7 dB: someone
 *  talking to their own phone clears this comfortably; the speaker's own leakage does not, once the
 *  coupling estimate has caught up with the room. */
const TRIGGER_MARGIN = 2.2;
/** How far over the room's noise floor a level has to be, during the probe, to count as a voice. */
const SPEECH_MARGIN = 3;
/** …and an absolute lower bound for that, for rooms quiet enough to make ratios meaningless.
 *  ~-38 dBFS: under speech at arm's length, over room tone. */
const ABS_SPEECH_FLOOR = 0.012;
/** Output level below which the speaker is effectively silent, so nothing needs ruling out and the
 *  probe can be skipped entirely (barge-in is then instant). */
const SILENT_OUTPUT = 0.005;

/** How long after the duck begins the microphone is genuinely hearing ducked audio: the gain ramp
 *  plus the buffer already handed to the hardware plus output latency. A chunk only counts once it
 *  lies ENTIRELY past this — a chunk straddling the ramp still carries full-volume echo in its first
 *  milliseconds, and an RMS over the whole chunk would report that as a voice. */
const PROBE_SETTLE_MS = 130;
/** How many settled chunks a probe reads before concluding it heard nothing. One is enough to say
 *  "yes, a voice"; saying "no" off a single chunk would miss anyone who happened to pause for breath
 *  inside it. */
const PROBE_QUIET_CHUNKS = 2;
/** After a probe says "that was just echo", don't re-probe for this long — otherwise a loud passage
 *  in the model's own speech probes over and over while the coupling estimate catches up. */
const PROBE_COOLDOWN_MS = 700;
/** Assumed spacing between mic chunks until the real one has been observed. */
const DEFAULT_CHUNK_MS = 100;
const MAX_CHUNK_MS = 400;

/** Starting guess for how much of the output comes back through the mic, before the call has taught
 *  us better. Middling on purpose: too low and the first loud syllable probes, too high and a real
 *  interruption in the first seconds is missed. */
const COUPLING_INIT = 0.5;
/** The estimate tracks the loudest recent mic-to-output ratio and decays toward it. ~0.5%/chunk
 *  (chunks are ~85 ms) — halves in about twelve seconds, so putting the phone down mid-call is
 *  followed, but one loud moment doesn't deafen the trigger for the rest of the call. */
const COUPLING_DECAY = 0.995;
const COUPLING_MIN = 0.05;
/** A mic reading many times the output level is the user, a handling noise, or AGC — not coupling.
 *  Clamping stops one such chunk from teaching the estimate that everything is echo. */
const COUPLING_MAX = 4;

/** Room tone is tracked as the quietest recent level, allowed to drift up this much per chunk so a
 *  single unusually quiet moment can't pin the floor low for the whole call. */
const FLOOR_DRIFT = 1.02;

export type BargeInput = {
  /** Level of this mic chunk, 0–1. */
  rms: number;
  /** Level of the audio our own player has scheduled around now, 0–1 (0 when nothing is playing). */
  ref: number;
  /** Whether the speaker was (or may still have been) sounding the model's voice for this chunk. */
  sounding: boolean;
  /** Monotonic-enough wall clock, ms. Passed in so this stays a pure function of its inputs. */
  nowMs: number;
};

/**
 * Decides when the user has started talking over the model, on a playback path where the mic can
 * still hear the speaker.
 *
 * Pure and synchronous — no audio nodes, no timers, no platform checks. Feed it every captured mic
 * chunk, including the ones the gate is dropping (those are the whole point), and act on the
 * returned {@link BargeAction}.
 */
export class BargeInDetector {
  /** Quietest sustained mic level seen while the speaker was silent. */
  private floor = Infinity;
  /** How much of our output level comes back through the mic, learned from this call. */
  private coupling = COUPLING_INIT;
  private hits = 0;
  private probeStartMs = 0;
  private probing = false;
  /** How many settled (genuinely ducked) chunks this probe has read. */
  private probeSamples = 0;
  /** The mic-to-output ratio that set the probe off, so a false alarm can teach the estimate. */
  private probeRatio = 0;
  private cooldownUntilMs = 0;
  /** Observed spacing between chunks, which is also their length — needed to tell whether a chunk
   *  lies wholly inside the ducked window or straddles its start. Measured rather than assumed
   *  because it follows from the device's sample rate. */
  private chunkMs = DEFAULT_CHUNK_MS;
  private lastNowMs = 0;

  /** A probe is in flight, so the player is ducked and this chunk's level is not representative. */
  get inProbe(): boolean {
    return this.probing;
  }

  /**
   * Abandon any probe in flight and disarm. Called wherever mic chunks stop arriving or stop being
   * judged (mute, tap-to-interrupt, a socket swap) — a probe is only ever concluded by a later chunk,
   * so without this the volume would stay down.
   *
   * What the call has learned about the room — its noise floor, its coupling, its chunk length —
   * deliberately survives: none of it is invalidated by a dropped probe, and re-learning it would
   * mean a fresh round of false alarms every time.
   */
  reset(): void {
    this.hits = 0;
    this.probing = false;
    this.probeSamples = 0;
    this.cooldownUntilMs = 0;
  }

  observe({ rms, ref, sounding, nowMs }: BargeInput): BargeAction {
    if (!Number.isFinite(rms) || rms < 0) return "none";

    // Track how far apart chunks arrive, taking the recent maximum so an unusually fast pair can't
    // shorten the settle and let un-ducked audio into a probe. Decays back down as spacing settles.
    if (this.lastNowMs > 0) {
      const delta = nowMs - this.lastNowMs;
      if (delta > 0 && delta <= MAX_CHUNK_MS) this.chunkMs = Math.max(delta, this.chunkMs * 0.9);
    }
    this.lastNowMs = nowMs;

    // A probe in flight owns the next fraction of a second: the output is ducked, so this is the reading
    // that actually settles the question. Note it runs whether or not the speaker is still marked as
    // sounding — the duck is precisely what makes it stop being.
    if (this.probing) return this.stepProbe(rms, nowMs);

    if (!sounding) {
      // Room tone (or the user talking, which only raises the floor — and a raised floor makes the
      // test more forgiving, never falsely strict). The gate is open anyway; nothing to decide.
      this.floor = Math.min(rms, this.floor === Infinity ? rms : this.floor * FLOOR_DRIFT);
      this.hits = 0;
      return "none";
    }

    // The speaker is sounding and the mic is gated shut. Is that the model, or the user cutting in?
    const expectedEcho = this.coupling * ref;
    const voiceFloor = this.speechFloor();

    if (rms <= Math.max(expectedEcho * TRIGGER_MARGIN, voiceFloor)) {
      // Consistent with our own output coming back. Take it as a fresh reading of the coupling: it's
      // the max of recent ratios, so the estimate rises to meet real echo and decays when it fades.
      this.learn(rms, ref);
      this.hits = 0;
      return "none";
    }

    this.hits++;
    if (this.hits < TRIGGER_CHUNKS) return "none";
    this.hits = 0;

    // Loud enough for long enough. If our own output is effectively silent there is no echo to rule
    // out and the answer is already in hand — interrupt now rather than ducking silence for 240 ms.
    if (ref < SILENT_OUTPUT) {
      this.cooldownUntilMs = nowMs + PROBE_COOLDOWN_MS;
      return "commit";
    }
    // Still cooling off from a probe that came back "echo" — the coupling estimate is catching up.
    if (nowMs < this.cooldownUntilMs) {
      this.learn(rms, ref);
      return "none";
    }

    this.probing = true;
    this.probeStartMs = nowMs;
    this.probeSamples = 0;
    this.probeRatio = ref > 0 ? rms / ref : 0;
    return "duck";
  }

  /**
   * One chunk during a probe. Rules the moment it has an answer rather than running a fixed window:
   * one settled chunk that's still loud settles it (that's a voice, cut in now), while saying "no"
   * waits for a couple of quiet ones so a breath between words isn't read as silence. Typically
   * around 200 ms to commit, 300 ms to stand down.
   *
   * A probe only ever ends on a later chunk, so if capture stops mid-probe — muted, hung up — it
   * would sit there with the volume down. The caller ends it with {@link reset} at those points,
   * which is also where the player's volume is restored.
   */
  private stepProbe(rms: number, nowMs: number): BargeAction {
    // Count only chunks that lie WHOLLY inside the ducked window — one that began before the duck
    // took effect still carries full-volume echo, which is exactly what this is trying to exclude.
    if (nowMs - this.probeStartMs - this.chunkMs < PROBE_SETTLE_MS) return "none";

    this.probeSamples++;
    if (rms > this.speechFloor()) {
      this.probing = false;
      return "commit";
    }
    if (this.probeSamples < PROBE_QUIET_CHUNKS) return "none";

    // The level fell away with our own volume, so it WAS our own volume. A direct measurement of the
    // coupling, better than anything inferred — take it, and hold off re-probing while it takes effect.
    this.probing = false;
    this.coupling = clamp(Math.max(this.coupling, this.probeRatio), COUPLING_MIN, COUPLING_MAX);
    this.cooldownUntilMs = nowMs + PROBE_COOLDOWN_MS;
    return "resume";
  }

  /** The level a chunk has to clear to be a voice rather than the room. */
  private speechFloor(): number {
    if (this.floor === Infinity) return ABS_SPEECH_FLOOR;
    return Math.max(this.floor * SPEECH_MARGIN, ABS_SPEECH_FLOOR);
  }

  /** Fold one echo-consistent reading into the coupling estimate. */
  private learn(rms: number, ref: number): void {
    if (ref < SILENT_OUTPUT) return; // dividing by near-silence says nothing about the room
    const observed = rms / ref;
    this.coupling = clamp(Math.max(observed, this.coupling * COUPLING_DECAY), COUPLING_MIN, COUPLING_MAX);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
