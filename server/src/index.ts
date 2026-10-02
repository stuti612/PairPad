import { existsSync } from 'node:fs'
import path from 'node:path'
import { createPairPadServer } from './server.js'
import { storageFromEnv } from './storage/index.js'

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

// Works from both src/ (tsx) and dist/ (compiled): each sits one level below server/.
const defaultStaticDir = path.resolve(import.meta.dirname, '../../client/dist')
const staticDir = process.env.STATIC_DIR ?? defaultStaticDir
const hasFrontend = existsSync(path.join(staticDir, 'index.html'))

const { storage, description } = await storageFromEnv()
const server = createPairPadServer({
  staticDir: hasFrontend ? staticDir : undefined,
  storage,
  maxUsersPerRoom: positiveInt(process.env.MAX_USERS_PER_ROOM),
  maxDocBytes: positiveInt(process.env.MAX_DOC_BYTES),
})
const boundPort = await server.listen(port, host)
console.log(`PairPad server listening on http://${host}:${boundPort}`)
console.log(`Storage: ${description}`)
if (!hasFrontend) {
  console.log(`No built frontend at ${staticDir}; serving the API and WebSocket only.`)
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

// Save every room before exiting, so a deploy or restart loses nothing.
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1)
    stopping = true
    server
      .close()
      .catch((error) => console.error('Error during shutdown:', error))
      .finally(() => process.exit(0))
  })
}
