// Shared Live-API building blocks used by BOTH the realtime call (liveSession.ts) and the one-shot
// voice-message reply (liveVoiceMessage.ts): the spoken-voice system instruction, the tool
// declarations, and the tool-call dispatcher. Keeping these in one place means a voice message answers
// with the exact same persona, memory blocks, and tools as a call — the only difference between the two
// surfaces is how audio flows (continuous duplex vs. a single push-to-talk turn).

import { type FunctionCall, type ThinkingConfig, ThinkingLevel } from "@google/genai";
import { BRAND_NAME_HEARING } from "./brandName";
import { ANSWER_FIRST, CAPABILITY_BOUNDS, CONFIDENTIALITY, NO_REPETITION, SAFETY_BOUNDS } from "./persona";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./recallTool";
import { isTaskTool, runTaskTool, TASK_TOOL_DECLARATIONS, TASKS_PERSONA } from "./taskTools";
import { FORGET_PERSONA, FORGET_TOOL_DECLARATIONS, isForgetTool, runForgetTool } from "./forgetTool";
import { FILES_PERSONA, FILE_TOOL_DECLARATIONS, isFileTool, runFileTool } from "./fileTools";
import { isSuggestionTool, RECORD_SUGGESTION_DECLARATION, runSuggestionTool, SUGGESTION_PERSONA } from "./suggestionTool";
import {
  isWebSearchTool,
  runWebSearchTool,
  SEARCH_PERSONA_AVAILABLE,
  SEARCH_PERSONA_UNAVAILABLE,
  SEARCH_WEB_DECLARATION,
} from "./webSearchTool";
import { FETCH_URL_DECLARATION, isUrlFetchTool, runUrlFetchTool, URL_FETCH_PERSONA } from "./urlFetchTool";
import {
  isLinkTool,
  LINK_PERSONA,
  type OutgoingLink,
  runSendLinkTool,
  SEND_LINK_DECLARATION,
} from "./linkTool";
import { currentTimeContext } from "./time";
import { aiReplyDirective, type Lang } from "@/i18n/config";

/**
 * How hard the Live model may think before it answers, as the admin set it (see the AI page). "" / an
 * unknown value means "auto": send no thinkingConfig at all and let the model use its own default —
 * which for Gemini 3.x Live is MINIMAL, chosen for latency.
 *
 * This is a real latency dial, not a quality freebie: on a hands-free call, thinking time is silence
 * before the assistant speaks. It's exposed per Live leg so the call can stay at auto while a voice
 * message — where the user has already sent the clip and is waiting — can afford to go deeper.
 */
export type LiveReasoning = "" | "minimal" | "low" | "medium" | "high";

const THINKING_LEVELS: Record<Exclude<LiveReasoning, "">, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * The `thinkingConfig` for a Live socket, or undefined to send none. Undefined (not an "auto" level) is
 * what preserves today's behavior exactly — the field is simply absent from the setup message, as it has
 * always been. An unrecognized value degrades to undefined rather than being passed through: the Live API
 * rejects a bad level at setup, and that fails the entire call rather than just this setting.
 */
export function liveThinkingConfig(reasoning: LiveReasoning | undefined): ThinkingConfig | undefined {
  const level = reasoning ? THINKING_LEVELS[reasoning] : undefined;
  return level ? { thinkingLevel: level } : undefined;
}

/** Base persona for a spoken reply — short and natural, since it's read aloud. Shared by call + voice
 *  message so the two sound like the same assistant. */
export const LIVE_VOICE_SYSTEM_INSTRUCTION =
  "You are EverVault, a warm and concise voice assistant. Keep replies short and natural for a spoken conversation.";

/**
 * The last word before the clock, for a session whose next input continues the conversation block.
 *
 * The block itself says all of this at length, but it sits near the top of a ~35k-character
 * instruction and everything after it is imperative rules — including TASKS_PERSONA, which is the
 * single largest block here and which explicitly authorises the clarifying question that was the
 * reported bug. This is the recency anchor: short, last, and about the one thing that went wrong.
 */
const CONTINUES_CONVERSATION_REMINDER =
  "FINALLY, THE THING MOST EASILY LOST IN EVERYTHING ABOVE: you are in the middle of a conversation, " +
  "and it is written out for you near the top of these instructions. What the user is about to say " +
  "continues it. So when they refer to something without naming it, the answer is almost always in " +
  "the last turn or two up there — go and read it before you ask them to tell you again. If you " +
  "yourself named the thing one turn ago, you already have your answer: use it, act, and say what " +
  "you acted on. Asking someone to repeat what you just said to them is the one reply this " +
  "conversation cannot afford.";

/** The memory/context blocks + preferences woven into a Live session's system instruction. Every field
 *  is optional so a memory-off session (or a caller that hasn't loaded a block) simply omits it. */
export type LiveContextOpts = {
  memoryEnabled: boolean;
  profileBlock?: string;
  stateBlock?: string;
  eventsBlock?: string;
  agendaBlock?: string;
  recentContext?: string;
  /** The current on-screen conversation rendered as a transcript, so a per-message session (the voice
   *  message) still "sees" the mixed text+voice history. The realtime call omits this — it keeps one
   *  live session whose history the server already retains. */
  conversationBlock?: string;
  /** The earlier message this voice message replies to, when the user picked one out with Reply (see
   *  renderQuotedReply). Voice-message sessions only — a call has no Reply button. */
  quotedReplyBlock?: string;
  /** True when the next thing the model receives is the next turn OF conversationBlock — the one-shot
   *  voice message. Adds the tail reminder below; see CONTINUES_CONVERSATION_REMINDER for why the
   *  block alone isn't enough. Ignored without a conversationBlock (a first message continues nothing). */
  nextTurnContinues?: boolean;
  /** Text the user typed and sent WITH this voice message (see renderTypedMessage). Voice-message
   *  sessions only — a realtime call has no composer. */
  typedMessageBlock?: string;
  /** Documents attached to this voice message, as text, plus the names of the images being shown as
   *  frames (see renderAttachments). Voice-message sessions only, same reason. */
  attachmentsBlock?: string;
  /** The user's chosen response-style directive ("" on default) — layered after the base voice persona. */
  styleInstruction?: string;
  language?: Lang;
  /** Whether the assistant may search the live web (an admin web-search key is configured). Independent
   *  of memory. Defaults to off, matching the honest "can't browse" persona. */
  searchAvailable?: boolean;
};

/**
 * Assemble the full system instruction for a Live session. Mirrors the layering the realtime call has
 * always used: memory/context blocks first (grounding the model from the first word), then the memory
 * personas, the base spoken-voice instruction, the user's style, the confidentiality/capability/safety
 * bounds, the reply-language directive, and finally the current time.
 */
export function buildLiveSystemInstruction(o: LiveContextOpts): string {
  const mem = o.memoryEnabled;
  return [
    // --- Background: what we know ABOUT this user, none of it said out loud in this conversation.
    // Kept together, and deliberately ahead of the conversation block below. They used to be split
    // either side of recentContext, which left the live conversation sitting dead-centre among them
    // and reading like one more of them — see renderConversation for the prod failure that caused.
    mem && o.profileBlock ? o.profileBlock : "",
    mem && o.stateBlock ? o.stateBlock : "",
    mem && o.eventsBlock ? o.eventsBlock : "",
    mem && o.agendaBlock ? o.agendaBlock : "",
    mem && o.recentContext ? o.recentContext : "",
    // Right after the blocks that invite the assistant to raise something of its own — spoken turns
    // derail the same way typed ones do, and interrupting someone out loud is worse.
    mem ? ANSWER_FIRST : "",
    // Alongside ANSWER_FIRST and for the same reason: those blocks are re-injected verbatim every
    // turn, so without this the reply to "what else?" is whatever they were just told again. Worse
    // out loud than on screen — a spoken repeat can't be skimmed past.
    mem ? NO_REPETITION : "",
    // --- Foreground: the conversation actually under way, and the message about to arrive in it.
    // Below the background on purpose, so the two are never read as the same kind of thing, and
    // immediately above the message it is the context for.
    o.conversationBlock || "",
    o.quotedReplyBlock || "",
    // Last of the context blocks and directly before the personas: everything above is what was said
    // BEFORE, these two are the rest of the message about to arrive.
    o.typedMessageBlock || "",
    o.attachmentsBlock || "",
    mem ? MEMORY_PERSONA : "",
    mem ? FILES_PERSONA : "",
    mem ? TASKS_PERSONA : "",
    mem ? FORGET_PERSONA : "",
    SUGGESTION_PERSONA,
    // Exactly one always survives .filter(Boolean): "you can search the web" vs "you can't right now".
    o.searchAvailable ? SEARCH_PERSONA_AVAILABLE : SEARCH_PERSONA_UNAVAILABLE,
    // Reading a page needs no key, so unlike search this is unconditional.
    URL_FETCH_PERSONA,
    // Matters most on this surface: a spoken reply's text IS its audio, so without send_link the model
    // cannot show a URL without reading it aloud.
    LINK_PERSONA,
    LIVE_VOICE_SYSTEM_INSTRUCTION,
    o.styleInstruction || "",
    // Matters most where the user is speaking: "EverVault" is the word they say to get the
    // assistant's attention, and it is the word the recognizer is least able to hear (see
    // brandName.ts). Without this the model takes "hello everybody" at face value.
    BRAND_NAME_HEARING,
    CONFIDENTIALITY,
    CAPABILITY_BOUNDS,
    SAFETY_BOUNDS,
    aiReplyDirective(o.language ?? "en"),
    // Deliberately last of the rules: the conversation block is a few hundred characters and roughly
    // 25k characters of persona follow it, several of which push toward asking a clarifying question.
    // Restating the one thing that matters here, where nothing buries it, is the cheap half of the fix.
    o.conversationBlock && o.nextTurnContinues ? CONTINUES_CONVERSATION_REMINDER : "",
    currentTimeContext(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The tool declarations for a Live session. record_suggestion is always available (forwarding feedback
 * doesn't need memory); when memory is on the model also gets recall_memory + the task, file and forget
 * tools, so it can search past chats, manage tasks and look up files the user sent mid-conversation.
 */
export function buildLiveToolDeclarations(memoryEnabled: boolean, searchAvailable = false) {
  return [
    {
      functionDeclarations: [
        ...(memoryEnabled
          ? [
              RECALL_MEMORY_DECLARATION,
              ...TASK_TOOL_DECLARATIONS,
              ...FILE_TOOL_DECLARATIONS,
              ...FORGET_TOOL_DECLARATIONS,
            ]
          : []),
        RECORD_SUGGESTION_DECLARATION,
        // Independent of memory — offered only when a web-search key is configured.
        ...(searchAvailable ? [SEARCH_WEB_DECLARATION] : []),
        // Always offered: reading a page is keyless, so there is nothing to gate it on.
        FETCH_URL_DECLARATION,
        SEND_LINK_DECLARATION,
      ],
    },
  ];
}

/**
 * Run the model's tool calls and return the functionResponses to send back over the socket. The dispatch
 * chain ends in a FALLTHROUGH to recall — anything without its own arm becomes a memory search — so each
 * tool family needs its explicit arm. The file/suggestion tools run without their optional UI callbacks:
 * a Live turn has no chat card to tap, so send_file reports "only in the text chat" while find_files
 * still works, and record_suggestion runs without screenshots.
 *
 * `onTasksChanged` is NOT optional in spirit: the caller's cached task list is what renders the agenda
 * block injected into the next turn as "authoritative", so a spoken change that doesn't refresh it
 * leaves the model reading dismissed tasks back as still open — dismissing them again, forever.
 */
export async function dispatchLiveToolCalls(
  calls: FunctionCall[],
  conversationId?: string,
  onTasksChanged?: () => void,
  onLink?: (link: OutgoingLink) => void,
): Promise<Array<{ id?: string; name?: string; response: { output: string } }>> {
  const results = await Promise.all(
    calls.map((c) => {
      const name = c.name ?? "";
      const args = c.args ?? {};
      return isSuggestionTool(name)
        ? runSuggestionTool(args)
        : isTaskTool(name)
          ? runTaskTool(name, args, onTasksChanged, conversationId)
          : isFileTool(name)
            ? runFileTool(name, args)
            : isForgetTool(name)
              ? runForgetTool(name, args)
              : isWebSearchTool(name)
                ? runWebSearchTool(args)
                : isUrlFetchTool(name)
                  ? runUrlFetchTool(args)
                  // Without onLink this reports that it cannot show links, rather than claiming success —
                  // the whole failure being fixed here was the model asserting a link had appeared.
                  : isLinkTool(name)
                    ? runSendLinkTool(args, onLink)
                    : runRecallTool(args);
    }),
  );
  return calls.map((c, i) => ({ id: c.id, name: c.name, response: { output: results[i] } }));
}
