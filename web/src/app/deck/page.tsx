// The talk, at /deck (and /ppt, which redirects here — see next.config.ts). Deliberately its own
// route rather than a section of the landing page: it is a full-viewport surface with its own
// keyboard handling, and it should be linkable on its own, down to the slide (/deck#7).

import type { Metadata } from "next";
import Deck from "./Deck";

export const metadata: Metadata = {
  title: "EverVault — building a personal memory AI",
  description:
    "A talk about EverVault: what it takes to give a text-in, text-out model a past, a database and the internet. RAG, embeddings, hybrid retrieval and tool calling, and how one self-hosted app puts them together.",
  // Nothing links here, and nothing should index it either. An unlinked route stays unlisted only
  // until the first person shares the URL somewhere a crawler can read it; after that, "unlinked"
  // stops being true and the page turns up in search for the site's own name. This keeps it out.
  // It is obscurity, not access control: anyone who has the URL can still open it.
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export default function DeckPage() {
  return <Deck />;
}
