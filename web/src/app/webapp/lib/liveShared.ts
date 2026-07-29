// Shared Live-API building blocks used by BOTH the realtime call (liveSession.ts) and the one-shot
// voice-message reply (liveVoiceMessage.ts): the spoken-voice system instruction, the tool
// declarations, and the tool-call dispatcher. Keeping these in one place means a voice message answers
// with the exact same persona, memory blocks, and tools as a call — the only difference between the two
// surfaces is how audio flows (continuous duplex vs. a single push-to-talk turn).

import { type FunctionCall } from "@google/genai";
import { CAPABILITY_BOUNDS, CONFIDENTIALITY, SAFETY_BOUNDS } from "./persona";
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
import { currentTimeContext } from "./time";
import { aiReplyDirective, type Lang } from "@/i18n/config";

/** Base persona for a spoken reply — short and natural, since it's read aloud. Shared by call + voice
 *  message so the two sound like the same assistant. */
export const LIVE_VOICE_SYSTEM_INSTRUCTION =
  "You are EverVault, a warm and concise voice assistant. Keep replies short and natural for a spoken conversation.";

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
    mem && o.profileBlock ? o.profileBlock : "",
    mem && o.stateBlock ? o.stateBlock : "",
    mem && o.eventsBlock ? o.eventsBlock : "",
    mem && o.agendaBlock ? o.agendaBlock : "",
    mem && o.recentContext ? o.recentContext : "",
    o.conversationBlock || "",
    mem ? MEMORY_PERSONA : "",
    mem ? FILES_PERSONA : "",
    mem ? TASKS_PERSONA : "",
    mem ? FORGET_PERSONA : "",
    SUGGESTION_PERSONA,
    // Exactly one always survives .filter(Boolean): "you can search the web" vs "you can't right now".
    o.searchAvailable ? SEARCH_PERSONA_AVAILABLE : SEARCH_PERSONA_UNAVAILABLE,
    // Reading a page needs no key, so unlike search this is unconditional.
    URL_FETCH_PERSONA,
    LIVE_VOICE_SYSTEM_INSTRUCTION,
    o.styleInstruction || "",
    CONFIDENTIALITY,
    CAPABILITY_BOUNDS,
    SAFETY_BOUNDS,
    aiReplyDirective(o.language ?? "en"),
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
                  : runRecallTool(args);
    }),
  );
  return calls.map((c, i) => ({ id: c.id, name: c.name, response: { output: results[i] } }));
}
