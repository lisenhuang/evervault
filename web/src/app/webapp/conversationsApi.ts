// The user's past conversations, for the history list in the sidebar.
//
// There is no conversations table behind this: a conversation is the set of recorded messages sharing a
// conversationId, and the server groups them on read (see ChatConversationsController). That is what makes
// the list retroactive — every chat held before this feature existed is already in it — and it is why the
// only thing the client can write here is what the user decided about a conversation, not the conversation
// itself, which the transcript recorder has been writing all along.
//
// Error convention follows the rest of this app: api() returns the raw Response and never throws on
// status, so every call here degrades to a safe value rather than propagating. A sidebar that fails to
// load is a sidebar that shows nothing, never a chat that fails to open.

import { api } from "./authApi";

export type Conversation = {
  conversationId: string;
  /** What to show: the stored name, or the opening words of what the user said. May be empty. */
  title: string;
  pinned: boolean;
  lastMessageAt: string;
  messageCount: number;
  /** Whether `title` is a stored name rather than the fallback — so a conversation is only ever
   *  summarised once, and a name the user chose is never overwritten. Absent from an older server. */
  named?: boolean;
};

/** The conversations to offer, pinned first and then most recent. */
export async function listConversations(opts?: { skip?: number; take?: number }): Promise<Conversation[]> {
  const params = new URLSearchParams();
  if (opts?.skip) params.set("skip", String(opts.skip));
  if (opts?.take) params.set("take", String(opts.take));
  try {
    const res = await api(`/api/chat/conversations?${params}`);
    if (res.ok) return (await res.json()) as Conversation[];
  } catch {
    /* offline, or the endpoint isn't there yet — the sidebar just stays empty */
  }
  return [];
}

/** Pin or unpin one conversation. Returns whether it stuck, so the caller can undo an optimistic flip. */
export async function setConversationPinned(conversationId: string, pinned: boolean): Promise<boolean> {
  return patchConversation(conversationId, { pinned });
}

/** Name a conversation. An empty title forgets the name, putting the row back to its opening words. */
export async function setConversationTitle(conversationId: string, title: string): Promise<boolean> {
  return patchConversation(conversationId, { title });
}

async function patchConversation(
  conversationId: string,
  patch: { pinned?: boolean; title?: string },
): Promise<boolean> {
  try {
    const res = await api(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}
