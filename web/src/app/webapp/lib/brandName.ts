// Keeping the product's own name intact when it comes back from speech recognition.
//
// "EverVault" is two ordinary English syllables joined into a word no recognizer has in its
// vocabulary, so it gets rewritten into whatever nearby real words fit the sound: "everybody",
// "everyone", "ever vault", "Evervolt". Said to a *personal* assistant that is the one word most
// likely to be in the sentence and the one most visibly wrong when it isn't — a user greeting
// EverVault by name watches their own bubble say "Hello everybody."
//
// Three layers, because no single one covers every path audio takes through the app:
//
//   1. TRANSCRIPTION_VOCABULARY_HINT — for the paths where WE write the transcription prompt (the
//      classic clip → text call, and audio attachments). Naming the word and its usual mishearings
//      is what actually fixes those, at the source.
//   2. BRAND_NAME_HEARING — a system-instruction line, so the model that answers understands the
//      name when it hears it and always spells it back the same way.
//   3. fixSpokenBrandName — a deterministic pass over transcript text. This is the only lever on the
//      Gemini Live paths (voice message + call): their input transcription is produced by the
//      recognizer, not by a prompt we control, so there is nothing to instruct — the text has to be
//      repaired after the fact.
//
// The repair pass is deliberately timid. Half of these mishearings are ordinary English words, and
// "correcting" one of those puts words in the user's mouth in their own permanent record — worse
// than the bug. So real words are only touched where they are being used to ADDRESS someone (see
// ADDRESSED_* below); everything else is left exactly as heard.

/** The product name, spelled the one correct way. */
export const BRAND = "EverVault";

/**
 * Vocabulary hint for a transcription prompt. Steering the recognizer is far better than repairing
 * its output, so every path that owns its own prompt gets this.
 */
export const TRANSCRIPTION_VOCABULARY_HINT =
  `The speaker is talking to an assistant called ${BRAND} and often says that name out loud, ` +
  `usually to address it ("Hello ${BRAND}", "${BRAND}, remind me…"). It is one word, capital E and ` +
  `capital V. Because it is not an ordinary word it is easily misheard as "everybody", "everyone", ` +
  `"ever vault", "Evervolt" or "Everfault" — whenever the speaker says it, write it as "${BRAND}".`;

/**
 * System-instruction line for every surface the user can speak on. Covers both directions: hearing
 * the name through a mishearing, and always writing it back the one correct way.
 */
export const BRAND_NAME_HEARING =
  `Your name and the product's name is "${BRAND}" — one word, capital E and capital V. Users say it ` +
  `out loud, and speech recognition mangles it into ordinary words: "everybody", "everyone", ` +
  `"ever vault", "Evervolt", "Everfault". When a message reads like the user is addressing you or ` +
  `naming the product ("hello everybody", "ever vault, remind me…"), take it as ${BRAND} and answer ` +
  `as the person's assistant — never as if you were being addressed as a group. Don't remark on the ` +
  `misheard word or correct them; just answer what they meant. Always write the name as ${BRAND}, ` +
  `however it arrived.`;

// ---------------------------------------------------------------------------------------------
// Repair pass
// ---------------------------------------------------------------------------------------------

// Second syllable heard wrong, or the seam between the two put in the wrong place. Nothing here is
// a sequence that turns up in ordinary speech ("ever volt", "everfault", "ever-vault"), so these
// are corrected unconditionally. Any trailing possessive is kept; a stray plural is dropped, since
// the name has none.
const MANGLED_EVER = /\bever[-\s]?(?:vault|volt|fault|bolt)s?(['’]s)?\b/gi;

// Same, but heard with "every"/"never" as the first syllable — corrected ONLY where the recognizer
// ran the two syllables together or hyphenated them. "everyvault" and "never-vault" are not words;
// "every vault" and "never fault" are perfectly ordinary English ("I would never fault you for
// that"), so the spaced forms are deliberately left alone.
const MANGLED_JOINED = /\b(?:every|never)-?(?:vault|volt|fault|bolt)s?(['’]s)?\b/gi;

// The mishearings that ARE real words. Correcting these on sight would rewrite "tell everybody I'll
// be late" into nonsense, so they are only corrected in the one position where they cannot be
// meant literally: addressing someone. This app is a one-to-one assistant — there is no group in
// the room to greet — so "hello everybody" is the user talking to EverVault.
const ADDRESSED_WORD = String.raw`every\s?body|everyone|every\s?buddy|ever\s?body`;

// Words that mark what follows as the thing being addressed. Longest-first so "good morning" wins
// over "morning" (either way the opener is preserved, but the match reads better in a debugger).
const OPENERS = [
  "good morning",
  "good afternoon",
  "good evening",
  "good night",
  "thank you",
  "all right",
  "hello",
  "hiya",
  "thanks",
  "goodbye",
  "alright",
  "morning",
  "evening",
  "okay",
  "hey",
  "bye",
  "hi",
  "yo",
  "ok",
].join("|");

// A greeting alone isn't enough: after one, the word is just as likely to be the SUBJECT of what
// follows ("Hi, everybody is coming tonight", "Thanks, everybody helped out today", "Hello,
// everybody who works here should know"). What actually separates an address from a subject is
// punctuation — a vocative is always set off by it, or ends the sentence. So the word must be
// followed by a clause boundary. Gemini punctuates its transcripts (the reported "Hello everybody."
// came back with the full stop), which is what makes this the precise test rather than a fussy one.
//
// The deliberate cost: an unpunctuated "hey everybody can you check my tasks" is left alone. That's
// the right way round to fail — a missed repair shows the user a word they can see is wrong, while
// a wrong repair quietly rewrites what they said. The model still understands them either way, via
// BRAND_NAME_HEARING.
const CLAUSE_END = String.raw`(?=\s*(?:[,，.。!！?？…;:]|$))`;

// The same test with the end-of-text arm removed, for text that is still arriving. Mid-stream, the
// end of the text is not the end of the sentence: a chunk that happens to break right after the
// word would make "Thanks, everybody" look complete, and the correction committed there could not
// be taken back when " helped out today." landed a moment later. Punctuation is the only end that
// means anything until the transcript is finished — so while streaming, that's the only one used.
const CLAUSE_END_STREAMING = String.raw`(?=\s*[,，.。!！?？…;:])`;

// "Hello everybody.", "Hey there everyone,", "thanks everybody" — a greeting, then the word, then
// the end of the clause.
const ADDRESSED_AFTER_OPENER = new RegExp(
  String.raw`\b(${OPENERS})([,，]?\s+(?:there\s+)?)(?:${ADDRESSED_WORD})\b${CLAUSE_END}`,
  "gim",
);
const ADDRESSED_AFTER_OPENER_STREAMING = new RegExp(
  String.raw`\b(${OPENERS})([,，]?\s+(?:there\s+)?)(?:${ADDRESSED_WORD})\b${CLAUSE_END_STREAMING}`,
  "gim",
);

// "Everybody, remind me to…" — the word opening a sentence and set off by a comma, which is a
// vocative and nothing else. Without the comma it is a subject ("everybody knows that") and stays.
const ADDRESSED_AT_START = new RegExp(String.raw`(^|[.!?…]\s+)(?:${ADDRESSED_WORD})(\s*[,，])`, "gim");

/**
 * Repair the product name in transcribed speech. Idempotent, which is what makes it safe to re-run
 * over the accumulated text on every delta — the name routinely arrives split across chunks
 * ("ever" then " vault"), so it can only ever be matched on the accumulated text, never on a delta.
 *
 * Pass `streaming: true` while the transcript is still arriving; the finished text (the classic
 * transcription result, a Live turn's final transcripts) is passed without it. The difference is
 * only how the end of the text is read — see CLAUSE_END_STREAMING.
 *
 * Only ever rewrites the brand name — see the comments above for why the real-word mishearings are
 * gated on being used as a form of address rather than corrected outright.
 */
export function fixSpokenBrandName(text: string, opts?: { streaming?: boolean }): string {
  if (!text) return text;
  const addressed = opts?.streaming ? ADDRESSED_AFTER_OPENER_STREAMING : ADDRESSED_AFTER_OPENER;
  return text
    .replace(MANGLED_EVER, (_m, possessive: string | undefined) => BRAND + (possessive ?? ""))
    .replace(MANGLED_JOINED, (_m, possessive: string | undefined) => BRAND + (possessive ?? ""))
    .replace(addressed, (_m, opener: string, gap: string) => `${opener}${gap}${BRAND}`)
    .replace(ADDRESSED_AT_START, (_m, before: string, after: string) => `${before}${BRAND}${after}`);
}
