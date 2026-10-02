import { createPairPadServer } from './server.js'

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

const server = createPairPadServer()
const boundPort = await server.listen(port, host)
console.log(`PairPad server listening on http://${host}:${boundPort}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close().finally(() => process.exit(0))
  })
}
