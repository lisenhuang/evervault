// Names a conversation from the first thing the user said, so the history list reads as a list of
// subjects rather than a list of opening lines.
//
// The fallback the server computes — the opening words, verbatim — is honest but often useless: "hey
// can you help me with something" tells you nothing about which conversation that was, and a voice
// message's transcript begins mid-thought more often than not. A summary is the difference between a
// list you scan and a list you have to read.
//
// Deliberately cheap and deliberately optional. One short call on the chat's own text model, made once
// per conversation after its opening exchange has been recorded, and every failure path ends in "no
// title" — where the derived fallback is still waiting. Nothing here is allowed to affect the reply the
// user is waiting for.

import { Type, type Schema } from "@google/genai";
import { generateJson } from "./gemini";

/** Titles longer than this stop being titles. The column takes 200; a sidebar row shows far less. */
const MAX_TITLE_CHARS = 60;

const TITLE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: { title: { type: Type.STRING } },
  required: ["title"],
};

const TITLE_SYSTEM =
  "You name conversations for a chat app's history list. Given how a conversation opened, reply with a " +
  "title of at most six words naming what it is ABOUT.\n" +
  "- Write it in the same language the user wrote in.\n" +
  "- No quotation marks, no trailing period, no prefix like \"Title:\", and never the word \"conversation\".\n" +
  "- Name the subject, not the act: \"Renewing the car insurance\", not \"User asks for help\".\n" +
  "- If the opening is only a greeting or too vague to have a subject, reply with an empty title rather " +
  "than inventing one — an honest blank is better than a wrong label the user then has to correct.";

/**
 * A short title for a conversation that opened with `firstUserText` (and, when it helps, the reply it
 * got). Returns "" whenever there is nothing worth naming or the call fails — callers treat that as
 * "leave it to the fallback" and must not retry in a loop.
 */
export async function summarizeConversationTitle(
  model: string,
  firstUserText: string,
  firstReplyText?: string,
): Promise<string> {
  const opening = firstUserText.trim();
  if (!opening) return "";
  // Only the opening exchange, and only the start of it: a title is decided by what the conversation
  // was opened ABOUT, and sending more would cost more to tell us the same thing.
  const parts = [`User: ${opening.slice(0, 1500)}`];
  if (firstReplyText?.trim()) parts.push(`Assistant: ${firstReplyText.trim().slice(0, 600)}`);

  try {
    const res = await generateJson<{ title?: string }>(
      model,
      [{ role: "user", parts: [{ text: parts.join("\n") }] }],
      TITLE_SYSTEM,
      TITLE_SCHEMA,
    );
    return cleanTitle(res?.title ?? "");
  } catch {
    return ""; // offline, quota, malformed JSON — the derived title is still there
  }
}

/** How much of the conversation a re-generated title reads. A title is a handful of words: past this
 *  the call costs more and says the same thing, and the middle of a long chat is the least of it. */
const REGEN_HEAD_TURNS = 8;
const REGEN_TAIL_TURNS = 8;
const REGEN_CHARS_PER_TURN = 500;

const REGEN_SYSTEM =
  "You name conversations for a chat app's history list. Given a conversation, reply with a title of " +
  "at most six words naming what it is ABOUT.\n" +
  "- Write it in the language the user wrote in.\n" +
  "- No quotation marks, no trailing period, no prefix like \"Title:\", and never the word \"conversation\".\n" +
  "- Name the subject, not the act: \"Renewing the car insurance\", not \"User asks for help\".\n" +
  "- Cover what the conversation turned out to be about, not only how it opened — an exchange that " +
  "begins \"hey, quick question\" and spends the rest of itself on a visa application is about the visa.\n" +
  "- If it covers several subjects, name the one it spent the most on rather than listing them.";

/** One turn of a conversation, as the title generator reads it. */
export type TitleTurn = { role: "user" | "assistant"; text: string };

/**
 * Re-name a conversation from the whole of it, for the re-generate button in the rename editor.
 *
 * Distinct from {@link summarizeConversationTitle}, which runs automatically off the opening exchange
 * because that is all that exists when a chat is first recorded. By the time someone asks for a better
 * name, the conversation has usually moved on from what it opened with — which is normally exactly why
 * they are asking. Returns "" if there is nothing to send or the call fails; the caller leaves the name
 * it already had.
 */
export async function regenerateConversationTitle(model: string, turns: TitleTurn[]): Promise<string> {
  const transcript = buildTitleTranscript(turns);
  if (!transcript) return "";

  try {
    const res = await generateJson<{ title?: string }>(
      model,
      [{ role: "user", parts: [{ text: transcript }] }],
      REGEN_SYSTEM,
      TITLE_SCHEMA,
    );
    return cleanTitle(res?.title ?? "");
  } catch {
    return ""; // offline, quota, malformed JSON — the name it already had stays
  }
}

/**
 * The conversation as the title model reads it: the opening turns, then the closing ones, with an
 * elision mark standing in for whatever was dropped between them.
 *
 * Head and tail, never the middle — how a conversation opened and where it ended up are what name it,
 * while the middle of a long one is mostly the working-out. Exported for its own test: head and tail
 * overlap for any conversation short enough to fit in both, and the clamp that stops a turn being
 * quoted twice is worth pinning down.
 */
export function buildTitleTranscript(turns: TitleTurn[]): string {
  const usable = turns.filter((t) => t.text.trim());
  if (usable.length === 0) return "";

  const head = usable.slice(0, REGEN_HEAD_TURNS);
  // Where the tail starts, clamped so it can never re-quote a turn the head already carried.
  const tailStart = Math.max(REGEN_HEAD_TURNS, usable.length - REGEN_TAIL_TURNS);
  const lines = head.map(line);
  // The mark means "turns were dropped here", so it is earned only when some actually were — which is
  // the turns between the two slices that EXIST. Comparing the clamped tailStart to the head length
  // alone marks a one-turn chat as elided, since tailStart floors at REGEN_HEAD_TURNS regardless of how
  // short the conversation is.
  if (Math.min(tailStart, usable.length) > head.length) lines.push("…");
  lines.push(...usable.slice(tailStart).map(line));
  return lines.join("\n");
}

function line(t: TitleTurn): string {
  const who = t.role === "user" ? "User" : "Assistant";
  return `${who}: ${t.text.trim().slice(0, REGEN_CHARS_PER_TURN)}`;
}

/** Strip what models add to titles however firmly they're asked not to, and bound the length. */
export function cleanTitle(raw: string): string {
  let t = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  // These arrive nested and in either order — `Title: "Booking the cottage."` is one real shape — so
  // strip in a loop rather than a fixed sequence, which would leave whichever wrapper was outermost.
  for (let pass = 0; pass < 3; pass++) {
    const before = t;
    t = t.replace(/^(title|标题|タイトル|제목)\s*[:：]\s*/i, "").trim();
    t = stripWrappingQuotes(t);
    t = t.replace(/[.。．]+$/, "").trim();
    if (t === before) break;
  }
  if (t.length > MAX_TITLE_CHARS) t = `${t.slice(0, MAX_TITLE_CHARS).trimEnd()}…`;
  return t;
}

/** Matched wrapping quotes — straight, curly, or CJK — but never a lone one, and never an apostrophe
 *  that happens to sit inside the words. */
function stripWrappingQuotes(t: string): string {
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["\u201c", "\u201d"],
    ["\u2018", "\u2019"],
    ["\u300c", "\u300d"],
    ["\u300a", "\u300b"],
  ];
  for (const [open, close] of pairs) {
    if (t.length > open.length + close.length - 1 && t.startsWith(open) && t.endsWith(close)) {
      return t.slice(open.length, t.length - close.length).trim();
    }
  }
  return t;
}
