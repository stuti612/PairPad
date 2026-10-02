import { existsSync } from 'node:fs'
import path from 'node:path'
import { createPairPadServer } from './server.js'

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

// Works from both src/ (tsx) and dist/ (compiled): each sits one level below server/.
const defaultStaticDir = path.resolve(import.meta.dirname, '../../client/dist')
const staticDir = process.env.STATIC_DIR ?? defaultStaticDir
const hasFrontend = existsSync(path.join(staticDir, 'index.html'))

const server = createPairPadServer({ staticDir: hasFrontend ? staticDir : undefined })
const boundPort = await server.listen(port, host)
console.log(`PairPad server listening on http://${host}:${boundPort}`)
if (!hasFrontend) {
  console.log(`No built frontend at ${staticDir}; serving the API and WebSocket only.`)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close().finally(() => process.exit(0))
  })
}
