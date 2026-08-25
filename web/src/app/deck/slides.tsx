// The talk itself. Each entry is one slide: `title` is what shows in the overview grid (press O),
// `node` is the slide. Everything is laid out against the fixed 1280x720 canvas in Deck.tsx.
//
// Editing: reorder or splice this array and the deck follows — the counter, the progress bar, the
// overview and the #n deep links are all derived from it, so there is no second place to update.
// Prose uses typographic quotes (’ “ ”) rather than ASCII ones, both because it sets better at
// projector size and because plain apostrophes in JSX text trip react/no-unescaped-entities.

import type { ReactNode } from "react";
import {
  Sparkles,
  BrainCircuit,
  Wrench,
  Mic,
  Server,
  Shield,
  Rocket,
  Coins,
} from "lucide-react";
import {
  Slide,
  Cols,
  Eyebrow,
  H1,
  H2,
  Grad,
  Lead,
  Body,
  Mono,
  Bullets,
  Numbered,
  Card,
  Stat,
  Quote,
  Note,
  Chips,
  Rows,
} from "./ui";
import {
  TextInTextOut,
  RagPaths,
  EmbeddingSpace,
  ThreeLanes,
  ToolLoop,
  Architecture,
} from "./diagrams";

export type SlideDef = {
  /** Stable id, used for the overview grid key. */
  id: string;
  /** Short label for the overview grid. */
  title: string;
  node: ReactNode;
};

export const SLIDES: SlideDef[] = [
  /* ------------------------------------------------------------------ 1 */
  {
    id: "title",
    title: "Title",
    node: (
      <Slide center>
        <Eyebrow icon={Sparkles}>evervault.life</Eyebrow>
        <div className="mt-[26px]">
          <H1>
            Remember everything.
            <br />
            <Grad>Carry nothing.</Grad>
          </H1>
        </div>
        <div className="mt-[26px] max-w-[820px]">
          <Lead>
            Building a personal memory AI. What it takes to give a text-in, text-out model a past,
            a database, and the internet.
          </Lead>
        </div>
        <div className="mt-[44px] flex flex-wrap items-center justify-center gap-x-[14px] gap-y-[6px] text-[length:var(--dk-lead)] text-black/45 dark:text-white/45">
          <span className="font-medium text-black/70 dark:text-white/70">Ethan Huang</span>
          <span aria-hidden="true">·</span>
          <span>Auckland</span>
          <span aria-hidden="true">·</span>
          <span>2026</span>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 2 */
  {
    id: "why-memory",
    title: "Why · memory",
    node: (
      <Slide>
        <Eyebrow tone="plain">Why I built this · 1</Eyebrow>
        <div className="mt-[22px] max-w-[980px]">
          <H2>Every chat AI forgets you the moment you close the tab.</H2>
        </div>
        <div className="mt-[34px]">
          <Cols ratio="1.05fr 0.95fr" gap={56} align="start">
            <Bullets
              items={[
                "You explain your context again. And again. Nothing ever accumulates.",
                "A context window is not memory. It is a whiteboard someone wipes at the end of the meeting.",
                "The parts of your life worth keeping are exactly the parts you mention once, in passing, and never think to repeat.",
              ]}
            />
            <Card>
              <Quote>
                Memory should not be a feature of somebody else’s product. It should be something
                you own: on your hardware, in your Postgres, under your keys.
              </Quote>
            </Card>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 3 */
  {
    id: "why-interaction",
    title: "Why · interaction",
    node: (
      <Slide>
        <Eyebrow tone="plain">Why I built this · 2</Eyebrow>
        <div className="mt-[22px] max-w-[980px]">
          <H2>And the interaction is never quite right.</H2>
        </div>
        <div className="mt-[30px]">
          <Cols ratio="1.05fr 0.95fr" gap={56} align="start">
            <div className="space-y-[22px]">
              <Bullets
                items={[
                  "The voice call talks over me. The reply will not stop. On iPhone the audio simply does not play.",
                  "None of these are hard problems. All of them are unfixable from the outside.",
                  "You file feedback into a black hole and wait for a roadmap that is not yours.",
                ]}
              />
              <Note>So I built one I am allowed to change.</Note>
            </div>
            <div className="space-y-[22px]">
              <Card>
                <Quote>
                  Owning the codebase turns “I wish it did X” into a commit. Feedback on Monday can
                  be live on Monday.
                </Quote>
              </Card>
              <div className="flex flex-wrap gap-x-[44px] gap-y-[16px]">
                <Stat value="227" label="commits" />
                <Stat value="52" label="days" />
                <Stat value="1" label="person" />
              </div>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 4 */
  {
    id: "what",
    title: "What it is",
    node: (
      <Slide>
        <Eyebrow icon={Sparkles}>EverVault</Eyebrow>
        <div className="mt-[22px] max-w-[900px]">
          <H2>
            A personal memory AI that runs <Grad>on hardware you own</Grad>.
          </H2>
        </div>
        <div className="mt-[32px]">
          <Cols ratio="1fr 1fr" gap={56} align="start">
            <div className="space-y-[20px]">
              <Body>
                Text, voice messages and live calls, with one memory behind all three. Photos and
                documents stay findable for good. One <Mono>make up</Mono> and it is yours: your
                keys, your database, your disk.
              </Body>
              <Chips items={["AGPL-3.0", "self-hosted", "no vendor account"]} />
            </div>
            <Rows
              rows={[
                ["web", "Next.js 16 · App Router · Tailwind v4"],
                ["api", ".NET 10 LTS · EF Core"],
                ["db", "Postgres 18 · pgvector"],
                ["mobile", "Expo SDK 56 · React Native"],
              ]}
            />
          </Cols>
        </div>
        <div className="mt-[38px] flex flex-wrap gap-x-[56px] gap-y-[18px]">
          <Stat value="73k" label="lines, web + api" />
          <Stat value="34" label="migrations" />
          <Stat value="12" label="tools the model can call" />
          <Stat value="4" label="display languages" />
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 5 */
  {
    id: "pure-function",
    title: "LLM = pure function",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          The concepts
        </Eyebrow>
        <div className="mt-[20px] max-w-[900px]">
          <H2>An LLM is one function: text in, text out.</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="0.92fr 1.08fr" gap={48}>
            <Bullets
              items={[
                "Stateless. Call it twice and the second call knows nothing about the first.",
                "No memory. No filesystem. No network. No database. It cannot reach anything.",
                "Every AI product you have ever used is scaffolding built around this one function.",
              ]}
            />
            <TextInTextOut />
          </Cols>
        </div>
        <div className="mt-[30px]">
          <Note>
            Two questions the rest of this talk answers: how do you give it a past, and how do you
            give it hands.
          </Note>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 6 */
  {
    id: "rag",
    title: "RAG",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          A past · RAG
        </Eyebrow>
        <div className="mt-[18px] max-w-[900px]">
          <H2>Retrieve first. Then generate.</H2>
        </div>
        <div className="mt-[26px]">
          <RagPaths />
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Bullets
              items={[
                "The naive fix is to paste your whole history into every prompt. It dies four ways: cost per token, latency, the context limit, and attention dilution.",
                "Ten thousand lines of history make the model worse at finding the one line that matters.",
              ]}
            />
            <Quote>
              The model never remembers. The database remembers, and we re-tell the model at the top
              of every single turn.
            </Quote>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 7 */
  {
    id: "embeddings",
    title: "Embeddings",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          A past · embeddings
        </Eyebrow>
        <div className="mt-[18px] max-w-[900px]">
          <H2>An embedding turns text into coordinates.</H2>
        </div>
        <div className="mt-[24px]">
          <Cols ratio="1.02fr 0.98fr" gap={48}>
            <div className="space-y-[18px]">
              <Bullets
                items={[
                  <>
                    A model maps a piece of text to a fixed-length list of floats. Here, 1536 of
                    them. That is a point in 1536-dimensional space.
                  </>,
                  "It is trained so that meaning, not spelling, decides where the point lands.",
                  <>
                    “That coast trip I was planning” and “Booked the cottage. Felt good to finally
                    decide.” share no word at all. Keyword search returns nothing. Nearest-neighbour
                    search returns it first.
                  </>,
                  <>
                    Similarity is the cosine of the angle between two vectors. Closer angle, closer
                    meaning.
                  </>,
                ]}
              />
            </div>
            <EmbeddingSpace />
          </Cols>
        </div>
        <div className="mt-[24px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Note>
              A vector database is just the index that makes “find the nearest 50 out of a million”
              sublinear instead of a full scan. pgvector’s HNSW builds a navigable small-world graph:
              approximate, and fast enough to live in the same Postgres as everything else. No second
              datastore.
            </Note>
            <Note>
              Stored as <Mono>halfvec</Mono>, fp16: half the disk of a full-precision vector, with
              negligible recall loss.
            </Note>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 8 */
  {
    id: "locked-dims",
    title: "Locked model + dims",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          A past · the constraint
        </Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>Why the embedding model, and its dimension, can never change.</H2>
        </div>
        <div className="mt-[28px]">
          <Cols ratio="1.06fr 0.94fr" gap={48} align="start">
            <Bullets
              items={[
                "A vector only means anything inside the space that produced it. Dimension 400 means whatever model A decided it means. Model B’s dimension 400 means something else entirely.",
                "Compare a vector from model A against one from model B and cosine still returns a number. It just is not a similarity. Silent, plausible garbage: the worst failure mode there is.",
                <>
                  Different widths do not even get that far. 768 against 1536 is a hard error, and an
                  HNSW index is built for one fixed width.
                </>,
                "So the query must be embedded by the same model, at the same dimension, as everything already stored. Store and search are two halves of one decision.",
              ]}
            />
            <div className="space-y-[18px]">
              <Card title="How that is enforced">
                The embedding config is locked the first time it is used (<Mono>LockedAt</Mono>), and
                the API rejects any vector whose length is not the locked dimension. Changing the
                embedding model means re-embedding every row. It is a migration, not a setting.
              </Card>
              <Card title="One subtlety">
                Same model, asymmetric hints. Stored text is embedded as{" "}
                <Mono>RETRIEVAL_DOCUMENT</Mono>, the query as <Mono>RETRIEVAL_QUERY</Mono>. A
                question and the answer it is looking for are not the same kind of text.
              </Card>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 9 */
  {
    id: "hybrid",
    title: "Hybrid search + RRF",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          A past · retrieval
        </Eyebrow>
        <div className="mt-[18px] max-w-[900px]">
          <H2>One kind of search is never enough.</H2>
        </div>
        <div className="mt-[24px]">
          <ThreeLanes />
        </div>
        <div className="mt-[22px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Bullets
              items={[
                "Vector search is good at meaning and bad at strings: exact names, IDs, rare words, typos. Full-text is the exact opposite. Trigram catches what both miss.",
                "Reciprocal Rank Fusion adds 1 / (60 + rank) from each lane, so three incomparable scores never have to be normalised against one another.",
              ]}
            />
            <div className="space-y-[14px]">
              <Rows
                rows={[
                  ["candidates per lane", "50"],
                  ["RRF constant", "k = 60"],
                  ["trigram threshold", "word similarity > 0.3"],
                  ["survive the re-rank", "6, into the system prompt"],
                ]}
              />
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 10 */
  {
    id: "not-a-silver-bullet",
    title: "Not a silver bullet",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          A past · the limit
        </Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>A vector database is not a silver bullet.</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1.05fr 0.95fr" gap={48} align="start">
            <Bullets
              items={[
                "Nearest-neighbour search answers one question: what is this like? It cannot answer whether something is true, whether it is done, or what is due on Thursday.",
                "Ask a vector index whether a task is finished and it hands you the three most similar-sounding tasks. Close enough is exactly wrong for state.",
                "So EverVault runs both, in one Postgres. Conversations, summaries and files are embedded and retrieved by meaning. Tasks, life events, profile facts, accounts and config are ordinary relational rows with keys, dates and constraints.",
              ]}
            />
            <div className="space-y-[16px]">
              <Card title="Where the line falls">
                If a near-miss answer is still useful, embed it. If a near-miss answer is a bug, put it
                in a table. The to-do list is the clearest case: a due date, a done flag, a unique key.
                Every one of those has to be exactly right, and none of them can be approximated.
              </Card>
              <Note>
                Because pgvector is an extension rather than a separate service, a memory and the task
                it produced are written in one transaction, not synced between two systems.
              </Note>
            </div>
          </Cols>
        </div>
        <div className="mt-[22px]">
          <Note>
            Which raises the next problem: retrieval can find a row, but it cannot write one. That
            needs hands.
          </Note>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 11 */
  {
    id: "tool-calling",
    title: "Tool calling",
    node: (
      <Slide>
        <Eyebrow icon={Wrench} tone="violet">
          Hands · tool calling
        </Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>How does a text-in, text-out model search the web?</H2>
        </div>
        <div className="mt-[24px]">
          <Cols ratio="1.08fr 0.92fr" gap={48}>
            <div className="space-y-[20px]">
              <Bullets
                items={[
                  "You hand it a menu: tool name, a description, and JSON-schema parameters.",
                  <>
                    Mid-reply, instead of prose, it can emit a structured{" "}
                    <Mono>functionCall {"{ name, args }"}</Mono>. That is still text out. It has done
                    nothing.
                  </>,
                  "Your code runs the function. HTTP, SQL, a file read, anything. Then you hand the result back as another message and let it continue.",
                  "Loop until it answers in plain prose.",
                ]}
              />
              <Quote>
                It never searches the web and never touches your database. It asks, and your program
                does it. The model proposes; the runtime disposes.
              </Quote>
            </div>
            <ToolLoop />
          </Cols>
        </div>
        <div className="mt-[22px]">
          <Note>
            This is also the whole security story. Every capability the model has is one you wrote,
            named, scoped and can revoke.
          </Note>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 12 */
  {
    id: "tools",
    title: "The 12 tools",
    node: (
      <Slide>
        <Eyebrow icon={Wrench}>In practice</Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>Twelve tools. One definition, every surface.</H2>
        </div>
        <div className="mt-[28px] grid grid-cols-3 gap-[18px]">
          <Card title="Memory">
            <Chips items={["recall_memory", "find_forgettable_memories", "forget_memories"]} />
          </Card>
          <Card title="Your life">
            <Chips items={["list_tasks", "add_task", "complete_task", "update_task"]} />
          </Card>
          <Card title="Files">
            <Chips items={["find_files", "send_file"]} />
          </Card>
          <Card title="The world">
            <Chips items={["search_web", "fetch_url", "send_link"]} />
          </Card>
          <Card title="Back to me">
            <Chips items={["record_suggestion"]} />
          </Card>
          <Card title="The loop">
            Five rounds maximum per turn. Calls within a round run in parallel.
          </Card>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Note>
              The same declarations and the same dispatcher serve typing and a live voice call, so a
              new tool lights up in both at once.
            </Note>
            <Note>
              <Mono>send_link</Mono> exists for a reason worth stating out loud: in a spoken reply the
              text is the audio, so without it the model would have to read a URL out character by
              character.
            </Note>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 13 */
  {
    id: "tool-traps",
    title: "Four traps",
    node: (
      <Slide>
        <Eyebrow icon={Shield}>In practice</Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>Four things that will bite you in a tool loop.</H2>
        </div>
        <div className="mt-[28px]">
          <Cols ratio="1.15fr 0.85fr" gap={48} align="start">
            <Numbered
              items={[
                {
                  title: "A tool that throws kills the loop.",
                  body: "Every runner returns a JSON string and never throws. Failures come back as a value for the model to paraphrase.",
                },
                {
                  title: "The dispatch fallthrough.",
                  body: "Ours ends in a memory search, so a tool name without its own arm is answered silently rather than erroring. Every new family needs its arm ahead of the fallthrough.",
                },
                {
                  title: "A fetched page is attacker-controlled text.",
                  body: "It is fenced as untrusted content, and any copy of the fence inside the page is rewritten. Otherwise a page prints the closing marker itself and everything after it reads as trusted.",
                },
                {
                  title: "Never let the model confirm a deletion.",
                  body: "forget_memories deletes nothing. It renders a card. Only a human tap deletes, and deleted facts are tombstoned so the same transcript cannot re-teach them.",
                },
              ]}
            />
            <Quote cite="web/src/app/webapp/lib/forgetTool.ts">
              The model is the least trustworthy party in a deletion flow. A model-authored “the user
              confirmed” flag would be self-certification and worth nothing.
            </Quote>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 14 */
  {
    id: "architecture",
    title: "Architecture",
    node: (
      <Slide>
        <Eyebrow icon={Server}>How it is built</Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>
            One host, one domain, one <Mono>make up</Mono>.
          </H2>
        </div>
        <div className="mt-[20px]">
          <Architecture />
        </div>
        <div className="mt-[20px] grid grid-cols-3 gap-[18px]">
          <Card title="Everything on one port">
nginx runs inside the app container alongside the frontend and the backend, so the API and the site share an origin. The mobile app then has one base URL and no CORS.
          </Card>
          <Card title="The app container is disposable">
            A deploy swaps it whole. The database is a separate container that never stops, so data
            survives every release.
          </Card>
          <Card title="No second datastore">
Memories, files, config and encrypted secrets all live in the same Postgres. Vector search is an extension, not a service.
          </Card>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 15 */
  {
    id: "write-path",
    title: "Write path",
    node: (
      <Slide>
        <Eyebrow icon={Server}>How it is built</Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>The write path: how a conversation becomes memory.</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1.05fr 0.95fr" gap={48} align="start">
            <Bullets
              items={[
                "Extraction runs in the browser, on the same model as the chat. The server never embeds and never extracts.",
                "Triggers: twenty seconds after a turn once at least four are new, on tab hide, on hanging up a call, and on starting a new chat.",
                "Window: the last twenty turns, sixty after a call, anchored on a cursor. A failed call rewinds the cursor rather than losing the window.",
                "One call returns facts, task completions, state changes, life events and a short summary.",
              ]}
            />
            <div className="space-y-[18px]">
              <Card title="The supersede anchor">
                <Mono>UNIQUE (user, category, key)</Mono>. Re-learning a fact overwrites it instead of
                piling up near-duplicates that all half-answer the same question.
              </Card>
              <Quote cite="web/src/app/webapp/lib/digest.ts">
                A digest is the missing middle: one short account of a whole week, so a long-horizon
                question gets a story instead of fragments.
              </Quote>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 16 */
  {
    id: "read-path",
    title: "Read path",
    node: (
      <Slide>
        <Eyebrow icon={Server}>How it is built</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>The read path, and where a recalled memory must go.</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[18px]">
              <Bullets
                items={[
                  "Every turn, automatically: build a query from the last three turns plus the current message, run the hybrid search, re-rank, keep six.",
                  "Separately, the model can call recall_memory itself for an explicit lookup or a date range.",
                ]}
              />
              <Card title="The bug that decided the design">
                Recall used to be injected as conversation. A user asked for a domain registration to
                go on their list and got back “Done, texting the locksmith to repair your door lock is
                on your list for August 13.” Their actual request untouched, and a two-day-old one
                answered in its place.
              </Card>
            </div>
            <div className="space-y-[18px]">
              <Quote cite="web/src/app/webapp/lib/recall.ts">
                Recalled memory is grounding, not conversation, so it now goes where the rest of the
                grounding lives.
              </Quote>
              <Rows
                rows={[
                  ["injected into", "the system instruction"],
                  ["cosine cutoff", "0.6, plus a relative cutoff"],
                  ["recency fade", "48 hours, then a 30-day half-life"],
                  ["dedupe", "Jaccard 0.6"],
                ]}
              />
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 17 */
  {
    id: "voice-thesis",
    title: "Voice is the interface",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>Interaction</Eyebrow>
        <div className="mt-[16px] max-w-[1000px]">
          <H2>
            Voice is how people actually communicate. <Grad>Text is the compression.</Grad>
          </H2>
        </div>
        <div className="mt-[20px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[14px]">
              <Card title="The usual way">
                Record. Upload the file. Transcribe it. Generate. Synthesize. Five hops, strictly in
                order, and the model never hears you. It reads a transcript of you.
              </Card>
              <Bullets
                items={[
                  "EverVault runs the live call and the one-shot voice message on the same model, over a WebSocket.",
                  "Your voice streams while you are still speaking. Nothing waits for a finished recording to upload.",
                  "So by the time you stop, the model already holds most of the turn. It has begun reasoning, and it may already have called a tool. The reply starts almost at once.",
                ]}
              />
            </div>
            <div className="space-y-[14px]">
              <Card title="One call, both transcripts">
                Spoken audio and text for both sides come back from a single streaming call, with no
                separate transcribe, reply and synthesize hops. Images go in the same way, so speaking
                over a photo is still one call.
              </Card>
              <Card title="Keyless by construction">
                The backend mints a short-lived token and the browser connects straight to the
                provider. Your audio never touches my server, and no key ever reaches the page. A
                plain reconnect deliberately keeps the same key, because a resumption handle only
                works inside the project that issued it. Only a quota or auth close advances to the
                next key in the pool.
              </Card>
            </div>
          </Cols>
        </div>
        <div className="mt-[18px]">
          <Note>
            Speed and depth trade against each other, and for everyday conversation speed is the
            right thing to buy. It is also why you should not ask it a hard maths question out loud.
          </Note>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 18 */
  {
    id: "voice-message",
    title: "Room to think",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>Interaction</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>
            A live call puts a clock on your thinking. <Grad>A voice message does not.</Grad>
          </H2>
        </div>
        <div className="mt-[20px]">
          <Cols ratio="1.05fr 0.95fr" gap={48} align="start">
            <div className="space-y-[14px]">
              <Bullets
                items={[
                  "On any platform, in a live call, pause for a second to think and the model reads the silence as your turn ending. It starts talking, at length.",
                  "So you learn not to pause, and to compose the whole sentence before opening your mouth. Voice-activity detection has quietly taxed thinking.",
                  "A voice message hands the clock back. You hold the button, you stop when you are ready, and nothing but you decides your turn is over.",
                  "It gives up none of the speed, because underneath it is the same streaming session, not a file upload.",
                ]}
              />
            </div>
            <div className="space-y-[14px]">
              <Card title="Voice in, voice out">
                If someone chose to speak, they have also chosen to listen. A spoken message comes back
                spoken, with the text alongside it, rather than as a wall of prose they now have to
                read.
              </Card>
              <Card title="And it survives a noisy room">
A call listens continuously, so it takes in whatever the room is doing. Holding a phone close to your mouth for a few seconds does not. Same model, far better signal, which is why a voice message still works on a bus where a call would not.
              </Card>
              <Quote>
                The interaction I use most, and the one I could only have got by building the app
                myself. Nowhere else is it a setting.
              </Quote>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 19 */
  {
    id: "barge-in",
    title: "Barge-in",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>Interaction</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>Interrupting the AI without it interrupting itself.</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[18px]">
              <Bullets
                items={[
                  "On a phone speaker the model hears its own voice. Naive voice-activity detection lets it interrupt itself, mid-sentence, forever.",
                  "Sniffing the platform does not work. The same phone echoes differently in a car and in a bedroom. So measure instead of guessing.",
                ]}
              />
              <Quote cite="web/src/app/webapp/lib/bargeIn.ts">
                Echo is by definition a copy of our own output: turn the output down and it
                disappears within milliseconds. The user’s voice does not.
              </Quote>
            </div>
            <div className="space-y-[18px]">
              <Card title="Trigger, then probe">
                Two consecutive chunks above 2.2 times the learned echo coupling arms the trigger.
                The output ducks for about 240 ms. Still loud means real speech: commit the
                interrupt. Gone quiet means it was echo: resume, and fold the reading back into the
                estimate.
              </Card>
              <Note>
                The coupling factor is learned per call, so the tenth interruption is better judged
                than the first. When output is already silent the probe is skipped and the interrupt
                is instant.
              </Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 20 */
  {
    id: "three-fixes",
    title: "Three fixes",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>Interaction</Eyebrow>
        <div className="mt-[16px] max-w-[1000px]">
          <H2>Three fixes that needed the source.</H2>
        </div>
        <div className="mt-[22px]">
          <Cols ratio="1.25fr 0.75fr" gap={44} align="start">
            <Numbered
              items={[
                {
                  title: "The spoken reply arrived silently on iPhone.",
                  body: "iOS unlocks autoplay only once an audio element has begun playing inside a user gesture, and playback is suppressed while the microphone is capturing, so priming it on the record button never took. Unlock on the first tap anywhere instead, before any capture exists, with ten milliseconds of silence.",
                },
                {
                  title: "The provider caps a live call at about ten minutes.",
                  body: "It closes the socket mid-conversation, and warns first. So the client keeps the latest resumption handle, reconnects on close, and hands it back: the new socket continues the same conversation with its context intact, and a sliding context window keeps an hours-long call off the model’s ceiling. People talk for an hour and never see the seam.",
                },
                {
                  title: "A call left open bills for silence.",
                  body: "Talk to it lying down at night and you will fall asleep with the socket running. An idle monitor hangs up for you, but only the user’s silent turn counts: the window resets while the model is speaking and while a reconnect is in flight, because a naive no-audio timer would hang up in the middle of a monologue.",
                },
              ]}
            />
            <div className="space-y-[16px]">
              <Quote>
                A few dozen lines each. Also three things that, anywhere else, you can only file as
                feedback and then wait.
              </Quote>
              <Note>
                Nobody asked for any of them. All three are the difference between something you use
                and something you try once.
              </Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 21 */
  {
    id: "cost",
    title: "Running it for free",
    node: (
      <Slide>
        <Eyebrow icon={Coins}>Operations</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>
            What it costs to run a personal AI: <Grad>almost nothing</Grad>.
          </H2>
        </div>
        <div className="mt-[28px] grid grid-cols-3 gap-[18px]">
          <Card title="The box">
            Oracle Cloud Always Free. Four cores, 24 GB of memory, 200 GB of disk, 4 Gbps of
            bandwidth. Enough to host the whole stack, and free indefinitely.
          </Card>
          <Card title="Voice, speech and vectors">
            Live calls, speech to text, text to speech, embeddings and memory extraction all run on
            pooled free-tier Gemini keys. Marginal cost per conversation is effectively zero.
          </Card>
          <Card title="The text answers">
            For the smartest replies, GPT-5.6 through the US$20 subscription I already pay for,
            reached by OAuth from the backend. The token never reaches the browser, and the cheaper
            model tier takes about 80% off what is left.
          </Card>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Bullets
              items={[
                "Pooled keys mean a quota wall rotates to the next key instead of becoming an error the user sees.",
                "Web search tries Brave first and falls back to grounded generation on the same free keys, so a rate limit degrades to a slower search rather than to no search.",
              ]}
            />
            <Quote>
              The running cost of a memory that keeps my whole life is a domain name and an hour of
              my weekend.
            </Quote>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 22 */
  {
    id: "ops",
    title: "Operated by talking",
    node: (
      <Slide>
        <Eyebrow icon={Rocket}>Operations</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>I do not SSH into it. I message it.</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[18px]">
              <Quote cite="CLAUDE.md, a rule in the repo">
                This project is meant to be developed and maintained largely by AI with minimal human
                action. Favour sane defaults and automation over steps a human must perform.
              </Quote>
              <Bullets
                items={[
                  "An agent runs on the server. I send it a Telegram message: back up the database, deploy the latest from GitHub. There is no terminal in the loop.",
                  "Which is exactly why runtime config goes through the admin UI into the encrypted database, not into .env and not into a file on disk. There is no human at a prompt to edit one.",
                ]}
              />
            </div>
            <div className="space-y-[18px]">
              <Card title="Deploys are boring on purpose">
                Build the new container alongside the running one, verify it on its own port, move
                the tunnel, drop the old. Real downtime is the tunnel restart.
              </Card>
              <Card title="When it breaks, find it fast">
                A pipeline built on models does not work 100% of the time, so the useful question is
                not how to prevent every failure but how quickly you can find the one that happened.
                Every user-visible failure carries an <Mono>EV-XXXXXXXX</Mono> code in an alphabet with
                no 0, 1, I, L, O or U, so it survives being read down a phone. The report and the AI
                call behind it are written to the database and listed in the admin dashboard, so a code
                a user reads out leads straight to the call that failed. Raw provider text never reaches
                the chat bubble.
              </Card>
              <Note>
                All 34 migrations follow expand, migrate, contract, because a deploy lands while
                somebody’s old page is still open.
              </Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 23 */
  {
    id: "compounding",
    title: "Why it compounds",
    node: (
      <Slide>
        <Eyebrow icon={Sparkles} tone="violet">
          Why it is worth building
        </Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>
            Memory is the only feature that <Grad>appreciates</Grad>.
          </H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[18px]">
              <Bullets
                items={[
                  "Every other feature is exactly as good on day one thousand as it was on day one. Memory is the opposite: close to useless in week one, irreplaceable by year three.",
                  "The more you talk to it, the more of you it holds. Not just what happened, but what you thought about it.",
                  "That asymmetry is the whole argument for owning it. You cannot export three years of being understood out of somebody else’s product.",
                ]}
              />
            </div>
            <div className="space-y-[18px]">
              <Card title="Where that leads: an AI version of you">
                Given enough of what happened to you and enough of your view on it, the memory holds
                more than your facts. It holds how you reason. So when family want to talk to you and
                you have no time, they can talk to the version of you that has been listening for
                three years. Not a chatbot wearing your name: your experience, and your way of
                reaching a conclusion.
              </Card>
              <Note>
                This is the part I am least certain how to get right, and the part I most want to
                build.
              </Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 24 */
  {
    id: "ceiling",
    title: "The model is the ceiling",
    node: (
      <Slide>
        <Eyebrow icon={Sparkles} tone="violet">
          What I actually learned
        </Eyebrow>
        <div className="mt-[18px] max-w-[1020px]">
          <H2>
            The interaction you can offer is <Grad>capped by the model you have</Grad>.
          </H2>
        </div>
        <div className="mt-[24px]">
          <Cols ratio="1.05fr 0.95fr" gap={48} align="start">
            <Bullets
              items={[
                "GitHub Copilot shipped in 2021 as autocomplete, running on Codex. Not because an agent was a worse idea, but because that model could finish a function and could not hold a plan across a repository. It was the right product for the model that existed.",
                "Agent mode did not arrive until February 2025. Three and a half years, and several model generations, for a feature anyone could already picture in 2021. Debugging, code review and pull requests came the same way: when models could carry them, not when someone first thought of them.",
                "Every decision in this talk sits on the same ceiling. Barge-in exists because the model streams. A voice message is one call because the model takes audio and images natively. Recall runs unasked because extraction is reliable enough to trust unattended.",
                "Two years ago, half of these would have been bad ideas, well built.",
              ]}
            />
            <div className="space-y-[16px]">
              <Card title="So build for the next ceiling, not this one">
                It changes what you optimise for: the least scaffolding you can manage between the
                model and the person, so that when the ceiling lifts the product rises with it and you
                delete code instead of writing it. Here that means one tool definition serving every
                surface, a memory that is only rows in Postgres, and the model itself being a dropdown
                in the admin page rather than an assumption in the code.
              </Card>
              <Quote>
                EverVault’s roadmap is not really mine. It belongs to the model, and I am building the
                part that gets to take advantage of it.
              </Quote>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 25 */
  {
    id: "close",
    title: "Close",
    node: (
      <Slide>
        <Eyebrow icon={Sparkles}>Where it goes</Eyebrow>
        <div className="mt-[20px] max-w-[1000px]">
          <H2>
            Two reasons, still the same two: <Grad>a memory I own</Grad>, and an interaction I am
            allowed to fix.
          </H2>
        </div>
        <div className="mt-[28px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[20px]">
              <Body>
                Nearly every slide in the middle of this talk started as something that annoyed me on
                a Tuesday. That is the whole argument for building your own.
              </Body>
              <Chips
                items={[
                  "your own cloned voice",
                  "audio-call reminders",
                  "talk on your own schedule",
                  "a memory that lasts",
                ]}
              />
            </div>
            <div className="rounded-[18px] border border-black/10 bg-white/70 p-[28px] text-center shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
              <div className="text-[38px] font-semibold tracking-tight">
                <Grad>evervault.life</Grad>
              </div>
              <div className="mt-[12px] text-[17px] text-black/55 dark:text-white/55">
                Open source, AGPL-3.0. Try it in the browser, or run it yourself.
              </div>
              <div className="mt-[18px] font-mono text-[15px] text-black/40 dark:text-white/40">
                make up
              </div>
            </div>
          </Cols>
        </div>
        <div className="mt-[34px]">
          <Note>Thank you. Questions welcome.</Note>
        </div>
      </Slide>
    ),
  },
];
