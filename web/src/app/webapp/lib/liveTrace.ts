// A short event trace of one Live reply, filed to /admin/errors when the reply goes wrong around a tool
// call. Live tool calls run between the browser and Google, so when the model says "a system error
// occurred" nothing on our backend saw it, and a screenshot can't tell a call that never reached us from
// one we answered badly or a socket Google closed. The trace records exactly that: which messages came,
// which tools ran and what they returned, and how the socket closed.

import { reportClientIssue } from "./errorReport";

const MAX_EVENTS = 60;

export class LiveTrace {
  private events: string[] = [];
  private startMs = Date.now();
  private toolCalls = 0;
  private problems: string[] = [];
  private sawInProgress = false;
  private turnText = "";
  private audioChunks = 0;

  constructor(
    private readonly surface: "call" | "voice",
    private readonly model: string,
    private readonly reasoning: string,
  ) {}

  add(event: string) {
    const line = `+${Date.now() - this.startMs}ms ${event}`;
    this.events.push(line);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    console.info(`[live:${this.surface}]`, line);
  }

  /** Model speech is summarised per turn (at turnComplete) rather than logged per chunk. */
  text(delta: string) {
    this.turnText += delta;
  }

  audio() {
    this.audioChunks += 1;
  }

  toolCall(calls: { id?: string; name?: string; args?: Record<string, unknown> }[]) {
    this.flushTurnText("before toolCall");
    this.toolCalls += calls.length;
    for (const c of calls) {
      this.add(`toolCall ${c.name ?? "?"} id=${c.id ?? "MISSING"} args=${JSON.stringify(c.args ?? {}).slice(0, 200)}`);
      if (!c.id) this.problem("tool call without an id");
    }
  }

  toolResult(name: string | undefined, ms: number, output: string) {
    this.add(`toolResult ${name ?? "?"} ${ms}ms ${output.slice(0, 200)}`);
    if (/"error"|tool failed to run/i.test(output)) this.problem(`${name ?? "tool"} returned an error`);
  }

  turnComplete(status: string | undefined) {
    this.flushTurnText(`turnComplete status=${status ?? "-"}`);
    if (status === "IN_PROGRESS") this.sawInProgress = true;
  }

  problem(what: string) {
    if (!this.problems.includes(what)) this.problems.push(what);
  }

  /**
   * The reply is over. File the trace if something went wrong, or if the model's own words say it did
   * after a tool was involved — the "a system error occurred" case, where every step can look fine.
   */
  finish(modelText: string, outcome: string) {
    this.flushTurnText(`finish ${outcome}`);
    if (this.sawInProgress && this.toolCalls === 0) this.problem("still-working turn but no tool call arrived");
    const involvedTools = this.toolCalls > 0 || this.sawInProgress;
    if (involvedTools && /error|fail/i.test(modelText)) this.problem("model reported an error");
    if (this.problems.length > 0) this.flush(modelText);
    this.reset();
  }

  private flushTurnText(event: string) {
    const said = this.turnText.trim();
    this.add(`${event}${said ? ` said="${said.slice(0, 160)}"` : ""}${this.audioChunks ? ` audio=${this.audioChunks}` : ""}`);
    this.turnText = "";
    this.audioChunks = 0;
  }

  private flush(modelText: string) {
    const detail = [
      `surface=${this.surface} model=${this.model} thinking=${this.reasoning || "auto"}`,
      `problems: ${this.problems.join("; ")}`,
      `model said: ${modelText.slice(0, 400)}`,
      ...this.events,
    ].join("\n");
    reportClientIssue(`live.${this.surface}`, `Live tool trace: ${this.problems.join("; ")}`, detail);
  }

  private reset() {
    this.events = [];
    this.startMs = Date.now();
    this.toolCalls = 0;
    this.problems = [];
    this.sawInProgress = false;
    this.turnText = "";
    this.audioChunks = 0;
  }
}
