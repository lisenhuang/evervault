# 🔐 EverVault

> **Your Personal Memory AI**

One stack. One domain. Web + API behind nginx, with Postgres + pgvector. 🐳

```
        🌐 Cloudflare  (TLS)
              │  http
              ▼
   ┌─────────────────────────────┐         ┌─────────────────────────┐
   │   nginx  :38378  (public)   │         │ 🐘 db  pgvector/pg18     │
   │     ├── /api/* ─▶ ⚙️  :38372 │──5432──▶│   trust auth · not       │
   │     └── /*     ─▶ 🖥️  :38373 │         │   exposed · pgdata vol   │
   └─────────────────────────────┘         └─────────────────────────┘
        app container (nginx+web+.NET)            db container
```

> 💡 **Why `db` is its own container:** the app container is disposable — `make up` swaps it for each new version while the DB keeps running, so data survives redeploys and app updates stay ~zero-downtime.

## 📦 Codebases

| Folder | Stack | |
|---|---|---|
| [`app/`](app/) | Expo SDK 56 · React Native | 📱 mobile |
| [`backend/`](backend/) | .NET 10 (LTS) Web API | ⚙️ api |
| [`web/`](web/) | Next.js 16 · App Router | 🖥️ website |

## 🧠 Text model — primary → fallback (webapp)

Both are picked in `/admin` → AI keys. The route depends on the **primary's provider**:

```
                 ┌─ Gemini ──▶ 🖥️ browser ─▶ /api/chat/ai/gemini proxy ─▶ Gemini
                 │             (pooled keys 🔑🔑 — failover is key-by-key; all fail → EV-code)
 💬 text turn ──▶│  primary?
                 │
                 └─ ChatGPT ─▶ ⚙️ /api/chat/ai/text ─▶ ChatGPT (admin's connected account —
                                   │                    token never reaches the browser)
                                   │ ❌ primary fails (quota / auth / transient)
                                   ▼
                              Text model — fallback  (e.g. Gemini on pooled keys 🔑🔑)
                                   │ ❌ fallback fails too
                                   ▼
                              502 + error code EV-XXXXXXXX
```

> The browser-side utilities — 🎙️ transcription · 🔊 TTS · 🧮 embeddings · 📝 memory extraction ·
> 🖼️ turns with images/files — always run on the **first Gemini choice** (primary if it's Gemini,
> otherwise the Gemini fallback), via the pooled-key proxy.

## 🎙️ Voice message → AI (webapp)

The admin picks a **primary** text model (Gemini or ChatGPT) + a Gemini **fallback**. Transcription
and TTS always run on the pooled Gemini keys; only the *answer* follows the primary.

```
 user 🎤 ─ audio ─▶ 🖥️ browser ──────▶ Gemini (transcribe) ──▶ 📝 transcript fills the bubble
                       │
                       │  answer, by primary text model:
                       │
        ┌─ Gemini ─────┴───────────── ChatGPT ─┐
        ▼                                      ▼
  raw audio ─▶ /api/…/gemini proxy      wait 📝 ─▶ /api/chat/ai/text ─▶ ChatGPT (admin account)
  (model hears the voice itself)               (⛑️ falls back to Gemini · no transcript? → Gemini)
        │                                      │
        └────────────── 💬 reply text ─────────┘
                              │
                              ▼
                 Gemini TTS ─▶ 🔊 spoken reply + 💬 text
```

### 🔊 Why the reply plays on its own (iOS)

iOS lets a page play sound **without a tap** only after an `<audio>` element has *begun playing inside a
gesture* — then it stays unlocked for its lifetime, even across new clips. The trap that made replies
silent: playback is suppressed **while the mic is capturing**, so priming on the record/stop tap never
took. Fix — unlock on the user's **first tap anywhere**, before any capture exists:

```
👆 first tap anywhere ──▶ 🔇 play 10 ms of silence ──▶ 🔓 element unlocked for good
   (sidebar · composer · mic-press — never mid-capture)

🔊 reply audio lands ──▶ el.play() ✅ auto-plays, no tap
                            │ ❌ in-app webview still blocks it
                            ▼
                     🎛️ Web Audio replay ──❌──▶ ▶️ "Play reply" (always works)
```

> 🖥️ macOS never suppresses playback for capture, so it worked there all along — the unlock dance is
> purely an iOS concern.

## 🧰 How the AI calls the tools we build

The model can't touch the app on its own. Each turn the browser hands it a list of **tool
declarations** (name + description + params) alongside the persona and transcript; the model, mid-reply,
can *ask* to call one instead of writing text. The browser runs it and feeds the result back. Repeat
until the model answers in plain text.

```
 each turn:  persona + transcript + tool declarations  ─▶  🤖 model
                                                              │
                      💬 shown to user ◀── plain text ────────┤ final answer
                                                              │
                                                              │ …or wants a tool
                                                              ▼
                                              functionCall { name, args }
                                                              │
                                       🖥️ runTool(name, args) — routes by name
                                                              │
                    ┌──────────────┬─────────────┬────────┴────┬──────────────┐
                    ▼              ▼             ▼             ▼              ▼
              recall_memory  record_suggestion  search_web  fetch_url   …tasks · files
                                                    │           │
                              POST /api/chat/websearch          │ POST /api/chat/fetchurl
                                                    ▼           ▼ (credentials stay server-side 🔑)
                                              { results:[ … ] } │ { title, content(markdown) }
                                                              JSON │ string
                    🤖 model reads the result ◀─────────────────────┘
                          (calls again, or writes the answer)
```

**Web tools** — two tiers, so a rate limit degrades instead of going dark:

| Tool | Path | Notes |
|---|---|---|
| `search_web` | Brave → Gemini `google_search` grounding | Fallback reuses the pooled AI keys (no extra subscription); free tier is 500 grounded req/day |
| `fetch_url` | Server-side fetch → Readability → markdown | No JS rendering; SSRF-guarded (connections pinned to vetted public IPs) |
| `send_link` | Posts the URL as its own chat message | Needed for **voice**: a spoken reply's text *is* its audio, so the model can't show a URL without reading it aloud |

**Anatomy of a tool** — `web/src/app/webapp/lib/webSearchTool.ts` is the smallest example:

| Piece | Role |
|---|---|
| `*_DECLARATION` | name + description + JSON-schema params the model sees |
| `*_PERSONA` | one line telling the model *when* to reach for it |
| `is*Tool(name)` | routes a call to this family |
| `run*Tool(args)` | does the work, returns a JSON **string**, and **never throws** (a throw breaks the loop) |

- **One definition, every surface.** Text chat (`gemini.ts` / `serverChat.ts`) and voice (`liveShared.ts`)
  share the same declarations + dispatcher, so a new tool lights up while typing *and* talking.
- **Dispatch ends in a fallthrough.** Any name without its own `is*Tool` arm is silently answered by
  `recall_memory` — so each new family needs an explicit arm *before* that fallthrough.
- **Secrets stay server-side.** `run*Tool` calls a backend endpoint; the browser never holds a key.
  `search_web` is offered when *any* provider can serve it (the `webSearch` flag on
  `GET /api/chat/ai/config`) — with none, the model is simply told it can't browse. `fetch_url` needs no
  key, so it is always offered.

## 🔌 Ports

| Port | Service | Exposed |
|---|---|---|
| **38378** | nginx (public entry) | ✅ host |
| 38373 | Next.js (web) | 🔒 internal |
| 38372 | .NET (backend) | 🔒 internal |
| 38377 | Postgres + pgvector | 🔒 `127.0.0.1` only (dev) · prod: not published |

## 🔐 Admin & data

- **`/admin`** — first visit creates the admin account (email + password); after that it's the
  login. Then a dashboard to configure **storage**.
- **Cloudflare R2** is configured from the dashboard (no `.env`) — the form tells you where to
  find each value; the secret is **encrypted** in the DB.
- **Google Sign-In** uses Google Identity Services (ID-token flow), so **no client secret is
  needed** — the backend trusts tokens by verifying Google's signature + the `aud` (Client ID)
  claim. The Client ID is public by design; the real gate is the **Authorized JS origins** set in
  the Google Cloud Console, which stops other sites from minting tokens as you.
- **Data persists** in the `pgdata` volume across `make up`/`make down`. ⚠️ `make clean` (`-v`)
  **wipes the database**; `make down` is the safe stop.
- Zero secrets to manage: passwordless DB (`trust`, never exposed) + admin cookies/keys auto-stored
  in the DB.

### Key API routes (under `/api`)

| Route | Purpose |
|---|---|
| `GET /api/health/db` | DB + pgvector health |
| `POST /api/admin/setup` · `POST /api/admin/login` | First-run create / login |
| `GET/POST/DELETE /api/memories` · `GET /api/memories/search?q=` | Memories (mutations require admin) |
| `GET/PUT /api/admin/storage` · `POST /api/admin/storage/test` | R2 storage config |

## 🚀 Make CLI

| Command | What it does |
|---|---|
| `make dev` | 🔥 Run with **hot reload** — edit & save, no rebuild |
| `make up` | 🚀 Build + run **prod**, auto-drop old versions, wait, print the 🔗 URL |
| `make down` | 🛑 Stop & remove the container |
| `make logs` | 📜 Tail logs |
| `make build` | 🔨 Build the prod image only |
| `make sh` | 🐚 Shell into the running container |
| `make clean` | 🧹 Tear down + drop volumes/images (fresh install) |
| `make prune` | ♻️ Reclaim disk — dangling images + all build cache |
| `make reset-admin` | 🔑 Delete the admin account → `/admin` shows first-run setup again |
| `make help` | ❓ List all commands |

## 🔵🟢 Zero-downtime deploy (server)

Blue-green swap behind the Cloudflare tunnel: the **old** container keeps serving until the **new**
one is verified, then traffic switches. `db` is a separate container that never stops, so data is
untouched. (`make up` is the simpler in-place alternative — a few seconds of downtime while the
single container recreates.)

| # | Step | How |
|---|---|---|
| 1 | Keep the current container running | _(do nothing)_ |
| 2 | Pull newest code | `git pull` |
| 3 | Build the new image — live site stays up | `make build` |
| 4 | Start it as a **second** container on another host port | `HOST_PORT=<new> docker compose -p evervault-next up -d app` |
| 5 | Test the new container locally | `curl -fsS localhost:<new>/api/health && curl -fsS localhost:<new>/` |
| 6 | Point the Cloudflare tunnel at the new port | edit tunnel config / dashboard |
| 7 | Restart the tunnel so traffic moves over | `systemctl restart cloudflared` (or `cloudflared` restart) |
| 8 | Verify the public site | open 👉 https://evervault.life |
| 9 | Remove the old container | `docker rm -f <old-app-container>` |

> ⏱️ **Real downtime = only the tunnel restart/switch — usually a few seconds.** If step 5 or 8
> fails, the old container is still live: just leave the tunnel as-is and drop the new container.

## ⚡ First run

```bash
make dev          # then open 👉 http://localhost:38378

cp .env.example .env   # 🧩 OPTIONAL — only to override defaults (e.g. HOST_PORT=80)
```

> ✅ **No `.env` needed** — sensible defaults are built in. Copy it only to tweak a knob.
> 🔁 In `make dev`, code changes hot-reload — you only rebuild when **dependencies** or the **Dockerfile** change.

## 🛠️ Run a single codebase (without Docker)

```bash
dotnet run --project backend/Evervault.Api   # ⚙️  api  → :38372
cd web && pnpm dev                            # 🖥️  web  → :38373
cd app && pnpm start                          # 📱  expo → QR / w·i·a
```

## 📄 License

**[AGPL-3.0](LICENSE)** plus two Section 7 terms in **[NOTICE](NOTICE)**. In short:

| You may | You must |
|---|---|
| Fork it and make your own version | Publish your source — **including if you only host it** (AGPL §13) |
| Use it commercially and charge for it | Credit EverVault where users can see it (§7(b)) |
| Modify anything | Give your version its own name, and not imply endorsement (§7(c)) |

Because §13 treats network use like distribution, a hosted fork can't stay closed —
the loophole that makes MIT/Apache attribution unenforceable for a web app.

Copyright is held solely by the author, who is not bound by the AGPL when licensing
to others — **commercial licenses** are available for use that the source-disclosure
term doesn't suit. See [NOTICE](NOTICE).
