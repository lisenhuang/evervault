// What to do with an AI-generated conversation name once it arrives.
//
// The answer is decided by what happened while the model was thinking, and that differs by device in a
// way that is easy to get wrong: on a phone, tapping the re-generate button dismisses the keyboard and
// blurs the box the name was destined for, so "the editor no longer has the cursor" is the normal case
// there rather than a sign the user walked away.
//
// Split out as a pure function because the component around it cannot be exercised here, and this flow
// has already shipped one bug (the name silently dropped on touch) that a table of cases would have
// caught before a phone did.

export type RenameOutcome =
  /** Throw it away: nothing usable came back, or the user has since said what they want. */
  | "discard"
  /** Put it in the box for the user to accept or edit — they are still sitting in it. */
  | "fill"
  /** Save it outright. They asked for this name and are no longer in the box to accept it. */
  | "apply";

export function decideRenameOutcome(input: {
  /** The generated name, already cleaned. Empty when the model had nothing worth saying. */
  title: string;
  /** Whether this request is still the one the user is waiting for — false once they save or cancel. */
  stillWanted: boolean;
  /** Whether the rename editor is still open on the conversation this name was generated for. */
  editingThis: boolean;
  /** Whether the text box still holds the cursor. False on touch, where the keyboard has gone. */
  focused: boolean;
}): RenameOutcome {
  const { title, stillWanted, editingThis, focused } = input;
  if (!title.trim() || !stillWanted) return "discard";
  // Still in the box with the cursor in it: offer it, don't impose it.
  if (editingThis && focused) return "fill";
  return "apply";
}
