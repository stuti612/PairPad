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

**Server tests** (`server/test`, 107 tests) start a real server on a random port and connect simulated clients over real WebSockets:

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

- A host that keeps a process running and supports WebSockets (on Replit, a Reserved VM deployment rather than Autoscale).
- **Exactly one instance.** Rooms live in the server's memory, so two instances would each hold their own copy of a pad.
- A Postgres database, supplied as `DATABASE_URL`. The tables are created on first start.

Build with `npm ci && npm run build` and start with `npm start`. The server reads `PORT` from the environment.

## Known limitations

- **No access control.** Anyone with a pad's link can read and edit it, by design.
- **Offline edits live in the open tab.** They are not saved to the browser's storage, so reloading or closing the tab while offline loses them. The browser warns before you do.
- **One server instance.** Scaling out would need a shared pub/sub layer between instances.
- **A hard crash can lose up to 300 ms of edits** on the server, unless a browser that still has the pad open reconnects, in which case it sends them again.
