// Turns bare URLs and email addresses in PLAIN message text into tappable links.
//
// The assistant's side of the chat goes through react-markdown + remark-gfm, which autolinks bare
// URLs for free. The user's own bubble deliberately does not: their message is rendered verbatim
// (`whitespace-pre-wrap`) so nothing they typed is reinterpreted as markup. That left a pasted link
// in their own message as dead text — visibly a URL, but nothing happened on tap. This closes that
// gap without opening the door to markdown: it only ever wraps a run of characters that already
// looks like an address, and never changes the text itself.

import type { ReactNode } from "react";

// A bare URL (explicit http/https scheme, or a scheme-less `www.` host) or an email address.
// Deliberately conservative: a plain "evervault.life" with no scheme and no `www.` is NOT matched,
// because ordinary typing ("done.Next", "3.5") would then light up as links. The URL body stops at
// whitespace and angle brackets; trailing sentence punctuation is trimmed off afterwards.
const LINK_RE = /(?:https?:\/\/|www\.)[^\s<>]+|[^\s<>@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

// Punctuation that almost always belongs to the sentence rather than the address, when it trails one.
const TRAILING = `.,;:!?'"”’)]}`;

/**
 * Drops sentence punctuation the match swallowed — "see https://x.com/a." should link `…/a`, not
 * `…/a.`. A closing bracket is kept when the address itself opened one, so links that legitimately
 * contain brackets (Wikipedia's `..._(disambiguation)`) survive.
 */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING.includes(url[end - 1])) {
    const ch = url[end - 1];
    const open = ch === ")" ? "(" : ch === "]" ? "[" : ch === "}" ? "{" : null;
    if (open) {
      const head = url.slice(0, end);
      const opened = head.split(open).length - 1;
      const closed = head.split(ch).length - 1;
      if (opened >= closed) break; // this bracket closes one inside the address — keep it
    }
    end--;
  }
  return url.slice(0, end);
}

/** The href a matched run should point at: `www.…` needs a scheme, an address needs `mailto:`. */
function hrefFor(match: string): string {
  if (/^https?:\/\//i.test(match)) return match;
  if (match.includes("@")) return `mailto:${match}`;
  return `https://${match}`;
}

/**
 * Renders `text` with every URL / email address in it as a link, and everything else untouched.
 * Returns the string as-is when there is nothing to link, so the common case allocates nothing.
 *
 * `className` styles the links (the caller owns the look — the blue user bubble and the light
 * assistant one want the same underline but inherit different colors).
 */
export function linkify(text: string, className?: string): ReactNode {
  LINK_RE.lastIndex = 0; // the regex is module-level and /g — reset before each run
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (let m = LINK_RE.exec(text); m; m = LINK_RE.exec(text)) {
    const url = trimTrailingPunctuation(m[0]);
    // Punctuation-only leftovers ("www." at the end of a sentence) aren't addresses — skip them and
    // let the text render as typed.
    if (!/[a-z0-9]/i.test(url.replace(/^https?:\/\//i, ""))) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a
        key={key++}
        href={hrefFor(url)}
        target="_blank"
        rel="noreferrer"
        className={className}
      >
        {url}
      </a>,
    );
    last = m.index + url.length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
