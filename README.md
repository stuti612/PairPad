# PairPad

A real-time collaborative code scratchpad. Create a pad, share the link, and two to ten people can type in the same document at once, with no sign-up.

- **Live editing** with syntax highlighting for JavaScript, TypeScript, Python and plain text. The language choice is shared by everyone in the pad.
- **Presence**: each person has a name and color, a live cursor and selection, and appears in a "who's here" list.
- **Works through disconnects**: you keep typing while offline and your edits merge when you reconnect.
- **Persistent**: pads survive server restarts and are deleted after 7 days without use.

Built with React, TypeScript and Vite on the client; Node.js, TypeScript and `ws` on the server; [Yjs](https://yjs.dev) for conflict-free merging; CodeMirror 6 for the editor.

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Browser, one per person"]
    CM["CodeMirror 6 editor"]
    YC["Y.Doc, local copy"]
    AW["Awareness: name, color, cursor"]
    CM <-->|"y-codemirror.next"| YC
  end

  subgraph Server["Node.js server, single process"]
    HTTP["HTTP: built frontend, /api/rooms, /health, /metrics"]
    WS["WebSocket endpoint /ws/roomId"]
    subgraph Room["Room, one per pad, in memory"]
      YS["Y.Doc, server copy"]
      AS["Awareness"]
    end
    PS["Persistence: batch writes, snapshots, cleanup"]
    WS <--> YS
    WS <--> AS
    YS --> PS
  end

  DB[("Postgres in production, SQLite in development")]

  YC <-->|"Yjs updates, binary"| WS
  AW <-->|"presence updates"| WS
  PS <--> DB
```

What happens when you type a character:

1. CodeMirror applies it to your local `Y.Doc` straight away, so typing never waits for the network.
2. The `y-websocket` provider sends the resulting Yjs update to the server over a WebSocket.
3. The server checks the update (well-formed, within the size limit), applies it to the room's `Y.Doc`, and relays it to everyone else in the room.
4. Each other browser applies the update to its own `Y.Doc`, and CodeMirror shows the change.
5. The server collects updates for 300 ms and writes them to the database as one row.

Presence (names, colors, cursors) travels the same WebSocket using Yjs awareness. It is never stored: it disappears when a person disconnects.

One Node process serves everything on one port: the built frontend, the HTTP API and the WebSocket endpoint.

## Why a CRDT instead of last-write-wins

With last-write-wins, each save replaces the document (or a region of it) with the newest version. If two people type at the same moment, whichever write arrives second wins and the other person's characters vanish. For a tool whose whole purpose is typing at the same time, that is the common case, not an edge case.

A CRDT (conflict-free replicated data type) avoids the conflict instead of picking a winner:

- Every character gets a permanent unique ID, and each edit is recorded relative to the characters around it ("insert `x` after character 41 from client A") rather than at a line and column.
- Because edits are described that way, they can be applied in any order, and more than once, and every copy still ends up identical.
- Nothing is overwritten. If you and I both type at position 0, both insertions are kept, in an order every copy agrees on.

That one property gives several things for free:

| Need | How the CRDT covers it |
| --- | --- |
| Simultaneous typing | Both edits are kept; nobody's characters are lost. |
| Offline editing | Edits made offline are ordinary edits that arrive late, and merge the same way. |
| Server restart | The stored document is a list of updates that can be replayed in any order. |
| Server crash | A browser that still has the pad open sends the server whatever it is missing. |

The costs are real but small here: a Yjs document carries some bookkeeping beyond the text, and deleted characters leave small markers behind. That is why the size limit below is measured on the stored document, not the visible text.

## AI collaborator: free setup

PairPad includes an AI pair programmer, "PairPad AI", that joins a pad as a participant. It runs only on free tiers that need no credit card, and the server keeps every API key; browsers never see one.

**Without a key**, the app works as normal and the AI panel says the AI isn't set up.

**To turn it on for free:**

1. Create a free Groq API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Optionally, create a GitHub personal access token with the **Models: read** permission at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens/new). It is used when Groq is rate limited.
3. Copy `.env.example` to `.env` and paste in the key (and token), or set them as environment variables (on Replit or Render, as secrets).
4. Restart the server. The startup log shows which providers and models are in use, for example `AI: Groq (openai/gpt-oss-120b, judged by openai/gpt-oss-20b), falling back to GitHub Models (...)`.

| Provider | Role | Default models (write / judge) | Free allowance | Key |
| --- | --- | --- | --- | --- |
| [Groq](https://console.groq.com) | Primary | `openai/gpt-oss-120b` / `openai/gpt-oss-20b` | 30 requests/min, 1,000/day, 8K tokens/min per model | `GROQ_API_KEY` |
| [GitHub Models](https://github.com/marketplace/models) | Fallback | `openai/gpt-4.1` / `openai/gpt-4.1-mini` | Depends on your GitHub plan; about 50 to 150 requests/day on the free plan | `GITHUB_TOKEN` |
| [OpenRouter](https://openrouter.ai) | Optional | free `:free` models only | 20 requests/min, 50/day without credits | `OPENROUTER_API_KEY` |
| Any OpenAI-compatible API | Optional | your choice | | `CUSTOM_*` |

Free catalogs change often. Check the models in your provider's dashboard and override them with `<PROVIDER>_MODEL` and `<PROVIDER>_JUDGE_MODEL` (see `.env.example`). Cerebras is supported too (`AI_PROVIDER=cerebras`), but since 2026 its free credits require a payment method on file, so it is not a default.

**How the free allowance is protected:**

- **Caps**: each pad may make 10 AI requests per hour and the whole server 100 per day (`AI_ROOM_HOURLY_LIMIT`, `AI_DAILY_LIMIT`). The AI panel shows what is left. One request makes at most four model calls, so 100 requests stay well inside Groq's 1,000 calls per day per model. The counts are kept in memory and reset when the server restarts.
- **Fallback**: if a provider answers with a rate-limit or quota error (or is down, too slow, or rejects the key), the request is tried once on the fallback provider. If that fails too, the person sees "AI is busy, try again in a minute" and nothing crashes.
- **Size**: at most 8,000 characters of selected code per request, with up to 12,000 characters of surrounding code for context. Larger pads are trimmed around the selection, and the model is told where lines were left out.
- **One at a time**: each pad runs one AI request at a time.

## Running locally

Requires Node.js 22.5 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. To try collaboration, open the same pad in a second window; use a private window so the two do not share a saved name.

To run it the way it is deployed, as a single server serving the built frontend:

```bash
npm run build
npm start        # http://localhost:3001
```

In development, pads are saved to `server/data/pairpad.sqlite`. Delete that file to start fresh.

## Tests

```bash
npm test             # server unit and integration tests (Vitest)
npm run test:e2e     # browser tests (Playwright; builds the app first)
npm run typecheck
```

The first `test:e2e` run needs a browser: `npx playwright install chromium`.

**Server tests** (`server/test`, 111 tests) start a real server on a random port and connect simulated clients over real WebSockets:

- Room creation, and rejection of invalid room IDs.
- Sync: relaying edits, late joiners, room isolation, and two clients editing concurrently and converging on the same text with no lost characters.
- Persistence: reload after a restart, snapshots, retry after a failed write, recovery from a client's copy after a crash, and the 7-day cleanup.
- Limits: 10 users per room, the 1 MB document limit, oversized and malformed messages.
- Storage: one set of tests runs against every backend. Postgres is covered by [PGlite](https://pglite.dev) (the Postgres engine compiled to WebAssembly), both called directly and through the production `pg` driver over a socket. Set `TEST_DATABASE_URL` to also run them against a Postgres server of your own.

**Browser tests** (`e2e`, 23 tests) drive two or more real Chromium windows against the production build: typing in both directions and at the same time, the language picker, presence and cursors, reconnecting and offline behaviour, and the limit screens.

### Load test

```bash
npm run loadtest                                  # starts its own throwaway server
npm run loadtest -- --url https://your-server     # or test a running one
npm run loadtest -- --help
```

By default it opens 50 simulated clients across 5 rooms, has each one type 2 characters per second for 15 seconds, and measures how long every edit takes to reach every other client in its room. It exits with an error if any edit was not delivered, any client was dropped, or a room's clients ended up with different text.

A run on a laptop, client and server on the same machine (so no network delay is included):

```
Clients            50 across 5 rooms
Duration           15.0 s
Edits sent         1499 (100 per second)
Deliveries         13491 of 13491
Disconnects        0
Rooms converged    yes

Latency, from an edit to another client applying it:
  min   0.4 ms
  mean  2.7 ms
  p50   2.5 ms
  p95   4.8 ms
  p99   6.7 ms
  max   9.3 ms

Server /metrics    1099.3 messages/s over the last 10 s, 16959 in total
```

The server's message count is higher than the edit rate because it counts every incoming frame: each keystroke sends a document update and a cursor update, and the stock `y-websocket` client also echoes presence updates it receives back to the server, which ignores them.

## Configuration

All settings are environment variables, and all are optional for local development.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | Port the server listens on. |
| `HOST` | `0.0.0.0` | Address the server binds to. |
| `DATABASE_URL` | not set | Postgres connection string. When set, Postgres is used. |
| `SQLITE_PATH` | `server/data/pairpad.sqlite` | SQLite file, used when `DATABASE_URL` is not set. `:memory:` for a throwaway database. |
| `GROQ_API_KEY`, `GITHUB_TOKEN`, ... | not set | AI provider keys. See "AI collaborator: free setup" and `.env.example`. |
| `REQUIRE_POSTGRES` | not set | Set to `1` to refuse to start without `DATABASE_URL`. Automatic on Replit deployments. |
| `STATIC_DIR` | `client/dist` | Built frontend to serve. |
| `MAX_USERS_PER_ROOM` | `10` | People allowed in one pad at a time. |
| `MAX_DOC_BYTES` | `1048576` | Largest stored document, in bytes. |

## Limits and endpoints

- **10 people per pad.** The 11th sees a "pad is full" page and can try again.
- **1 MB per document**, measured as the encoded Yjs document (text plus CRDT bookkeeping), because that is what is stored and sent to each person who joins. The editor stops accepting new text at 900 kB to leave room for the bookkeeping. Deleting is always allowed.
- **Malformed messages** close that connection; nobody else in the room is affected.
- **Inactive pads** are deleted after 7 days. Opening a pad counts as activity.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/rooms` | Returns a new random room ID. |
| `GET /health` | `{ status, rooms, clients, messagesPerSecond }` |
| `GET /metrics` | The same counts plus total messages, uptime and the configured limits. |
| `WS /ws/<roomId>` | Yjs sync and awareness, using the `y-websocket` protocol. |

"Rooms" are rooms currently in memory; "messages per second" is an average over the last 10 seconds.

## Persistence

A pad is stored as a list of Yjs updates in two tables (`rooms`, `room_updates`), behind a small interface (`server/src/storage/types.ts`) with three implementations: Postgres, SQLite and in-memory.

- Edits are collected for 300 ms and written as one merged update.
- After 100 rows, or when the last person leaves, the rows are replaced by a single snapshot.
- On `SIGTERM` or `SIGINT`, every pad in memory is saved before the process exits.
- A pad is unloaded from memory 30 seconds after the last person leaves and reloaded when someone opens it again.
- A failed write is kept and retried.

## Project layout

```
client/              React + Vite frontend
  src/pages/         Landing, Pad, NotFound
  src/components/    Editor, TopBar, PresenceMenu, StatusBadge
  src/lib/           Yjs session, presence, connection status, remote cursors
server/
  src/server.ts      HTTP + WebSocket server, limits, metrics
  src/room.ts        One Y.Doc per room; sync and awareness; room lifecycle
  src/persistence.ts Batching, snapshots, retries
  src/storage/       Postgres, SQLite and in-memory backends
  test/              Vitest unit and integration tests
  loadtest/          Load test script
e2e/                 Playwright browser tests
```

## Deployment

The app is one long-running Node process and needs:

- A host that keeps a process running and supports WebSockets.
- **Exactly one instance.** Rooms live in the server's memory, so two instances would each hold their own copy of a pad.
- A Postgres database, supplied as `DATABASE_URL`. The tables are created on first start.

Build with `npm ci --include=dev && npm run build` and start with `npm start`.

### Deploying on Replit

The repository includes a `.replit` file with the build and run commands and the deployment type.

1. In Replit, choose **Import code or design**, then **GitHub**, and select this repository.
2. Add the database: open the **Database** tool in the workspace and create a PostgreSQL database. This provides `DATABASE_URL`.
3. Press **Run** once to check it starts. The console should print `Storage: Postgres`.
4. Open **Deployments** (or **Publish**), choose **Reserved VM**, keep the build and run commands from `.replit`, and deploy. Do not choose Autoscale: it can start several instances and stop them when idle.
5. Open the deployment's logs and confirm they also say `Storage: Postgres`.

A deployment without `DATABASE_URL` refuses to start instead of saving pads to a local file, because a deployment's disk may not survive a restart.

Then check the live app:

```bash
curl https://<your-app>.replit.app/health
npm run loadtest -- --url https://<your-app>.replit.app
```

The server listens on port 3001 unless `PORT` is set; `.replit` maps that port to the public one.

## Known limitations

- **No access control.** Anyone with a pad's link can read and edit it, by design.
- **Offline edits live in the open tab.** They are not saved to the browser's storage, so reloading or closing the tab while offline loses them. The browser warns before you do.
- **One server instance.** Scaling out would need a shared pub/sub layer between instances.
- **A hard crash can lose up to 300 ms of edits** on the server, unless a browser that still has the pad open reconnects, in which case it sends them again.
