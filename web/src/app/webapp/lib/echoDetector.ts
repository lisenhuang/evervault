// Decides, per call, whether the model's voice is ACTUALLY coming back through the microphone —
// instead of assuming it does because of what platform this is.
//
// Background. The model's voice is generated with the Web Audio API. On desktop and Android we route
// it through a local WebRTC loopback (echoLoopback.ts) so the browser's echo canceller treats it as
// the far-end reference and subtracts it from the mic. On iOS/WebKit that loopback plays back silent
// — tried, fixed three separate ways, and abandoned in bd60ae8 — so the voice goes straight to the
// speaker where the echo canceller cannot see it. The mic then hears the model, Gemini's VAD hears
// speech, and the model interrupts itself. The workaround was to gate the mic shut whenever the
// speaker might be sounding (half duplex, so no barge-in) and to offer a "I'm on headphones" button
// that lifted the gate manually.
//
// The platform is the wrong thing to key that on. What actually matters is whether sound makes it
// from this device's speaker to this device's microphone, and that is a property of the moment, not
// of the OS: on AirPods or any headset the acoustic path simply doesn't exist, and if WebKit ever
// fixes its end the path is cancelled anyway. Both are directly observable — the mic keeps capturing
// while the gate is shut (the gate only stops chunks being SENT), so the model's turns are free
// measurements of exactly the thing in question.
//
// So: start gated, which is the safe assumption and today's behaviour, and watch. If the model can
// speak through a couple of complete turns without the microphone hearing anything above the room's
// own noise floor, there is no acoustic path, and the gate lifts for the rest of the call — barge-in
// comes back and the headphones button has nothing left to do. If echo ever does show up, the gate
// closes again and stays closed.
//
// Deliberately not DSP. It never tries to REMOVE echo, only to notice whether any is present, which
// is a far easier question and fails safe: an inconclusive answer keeps the gate exactly where it is.

/** Chunks of ambient measurement before any verdict — roughly a second of room tone. Without it a
 *  call answered mid-sentence could take the user's own voice for the noise floor. */
const MIN_FLOOR_CHUNKS = 10;
/** Model speech shorter than this isn't evidence of anything; a two-word "mm-hm" barely opens the
 *  speaker. Counted in mic chunks observed while the model was sounding. */
const MIN_TURN_CHUNKS = 6;
/** How many complete, quiet model turns it takes to conclude there is no acoustic path. Two rather
 *  than one because the cost of being wrong is the model interrupting itself, and the cost of
 *  waiting is one extra reply before barge-in returns. */
const CLEAN_TURNS_TO_OPEN = 2;
/** The mic may sit this many times above the room's floor during a model turn and still count as
 *  quiet — room tone is not perfectly stationary, and a small margin avoids reading its wobble as
 *  echo. */
const ECHO_MARGIN = 3.5;
/** …and never judge below this absolute level, whatever the ratio says. In a very quiet room the
 *  floor can be near zero, where any ratio explodes. ~-36 dBFS: well under speech through a phone
 *  speaker (about -25 to -15 dBFS), comfortably above room tone. */
const ECHO_ABS_FLOOR = 0.015;
/** The floor tracks the quietest recent room tone but is allowed to drift UP this much per chunk, so
 *  a single unusually quiet moment early in the call can't pin it low for the whole session (which
 *  would make every later turn look like echo). ~2%/chunk ≈ recovers in a couple of seconds. */
const FLOOR_DRIFT = 1.02;

/**
 * Watches the microphone across the model's speaking turns and decides whether the mic gate is still
 * needed. Feed it every captured chunk — including the ones being dropped by the gate, which are the
 * informative ones.
 *
 * Pure and synchronous: no audio nodes, no timers, no platform checks. `open` starts false, so a
 * caller that never gets a usable reading behaves exactly as it did before this existed.
 */
export class EchoDetector {
  /** Quietest sustained mic level seen while the model was NOT speaking. */
  private floor = Infinity;
  private floorChunks = 0;
  /** Whether the previous chunk was observed during model speech, for turn edges. */
  private wasSpeaking = false;
  /** Loudest mic level during the model turn in progress, and how much of it we've seen. */
  private turnPeak = 0;
  private turnChunks = 0;
  private cleanTurns = 0;
  /** Echo was proven at some point: the gate stays shut for the rest of the call, no second chances. */
  private proven = false;
  private opened = false;
  /** The turn under way has been disqualified as evidence — see {@link ignoreTurn}. */
  private ignoring = false;

  /** True once the model has spoken through enough quiet turns that the mic can safely stay open. */
  get open(): boolean {
    return this.opened;
  }

  /** Whether a verdict has been reached either way — for diagnostics, not for gating. */
  get settled(): boolean {
    return this.opened || this.proven;
  }

  /**
   * Observe one captured mic chunk.
   *
   * @param rms       level of the chunk, 0–1 (see MicStreamer).
   * @param speaking  whether the model's voice was (or may still have been) sounding for it.
   */
  observe(rms: number, speaking: boolean): void {
    if (!Number.isFinite(rms) || rms < 0) return;

    if (speaking) {
      this.turnChunks++;
      if (rms > this.turnPeak) this.turnPeak = rms;
      this.wasSpeaking = true;
      return;
    }

    // Not speaking: this chunk is room tone (or the user talking, which only ever raises the floor —
    // and a raised floor makes the test MORE forgiving, never falsely strict).
    this.floor = Math.min(rms, this.floor === Infinity ? rms : this.floor * FLOOR_DRIFT);
    this.floorChunks++;

    if (this.wasSpeaking) {
      this.wasSpeaking = false;
      this.endTurn();
    }
  }

  /**
   * Throw away the turn in progress: something else has established that the mic was picking up the
   * USER during it, not the speaker (see bargeIn.ts, which proves exactly that by ducking the output
   * and finding the voice still there).
   *
   * Without this, interrupting the model would read as "the mic hears the speaker" and shut the gate
   * for the rest of the call — so barging in once on headphones would cost the very full duplex the
   * detector exists to grant. A disqualified turn counts neither way; the next one decides.
   */
  ignoreTurn(): void {
    this.turnPeak = 0;
    this.turnChunks = 0;
    this.ignoring = true;
  }

  /** A model turn just finished — judge it. */
  private endTurn(): void {
    const peak = this.turnPeak;
    const chunks = this.turnChunks;
    this.turnPeak = 0;
    this.turnChunks = 0;
    if (this.ignoring) {
      this.ignoring = false;
      return;
    }

    // Too short to mean anything, or we don't yet know what this room sounds like. Neither counts
    // for nor against — the gate simply stays where it is.
    if (chunks < MIN_TURN_CHUNKS || this.floorChunks < MIN_FLOOR_CHUNKS || this.floor === Infinity) return;

    const quiet = peak <= Math.max(this.floor * ECHO_MARGIN, ECHO_ABS_FLOOR);
    if (quiet) {
      if (this.proven) return; // echo was demonstrated earlier; a quiet turn doesn't undo it
      this.cleanTurns++;
      if (this.cleanTurns >= CLEAN_TURNS_TO_OPEN) this.opened = true;
      return;
    }

    // The mic heard the model. Whether that's echo or the user talking over it, the safe reading is
    // the same, and once seen it's permanent for this call: a gate that flapped open and shut would
    // let the model interrupt itself again every time the room went briefly quiet.
    this.cleanTurns = 0;
    this.proven = true;
    this.opened = false;
  }
}
