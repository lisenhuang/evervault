/**
 * The keyboard chord that shows and hides the desktop rail — ⌘B on a Mac, Ctrl+B everywhere else,
 * the binding VS Code, Slack and Notion all use, so most people already have it in their fingers.
 *
 * The matcher and the printed label live in ONE module on purpose: a tooltip that promises a chord
 * the handler doesn't listen for is worse than no tooltip at all.
 */

function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  // "Macintosh" (every desktop Safari/Chrome/Firefox UA on macOS) matches "Mac". navigator.platform
  // would be shorter but is deprecated and already frozen in some browsers.
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** True for the show/hide chord, and only for it: any extra modifier means the user meant something
 *  else (Ctrl+Shift+B is the browser's own bookmarks bar). */
export function isSidebarShortcut(e: KeyboardEvent): boolean {
  // Auto-repeat from a held key would strobe the rail open and shut at the repeat rate.
  if (e.repeat || e.altKey || e.shiftKey) return false;
  const apple = isApple();
  if (apple ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
  // toLowerCase because a held Caps Lock reports "B". `key` rather than `code` so the chord follows
  // the letter the user sees on their keycap on a non-QWERTY layout.
  return e.key.toLowerCase() === "b";
}

/** How to print the chord in a tooltip. */
export function sidebarShortcutLabel(): string {
  return isApple() ? "⌘B" : "Ctrl+B";
}
