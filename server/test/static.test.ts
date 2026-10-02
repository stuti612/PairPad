import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './helpers.js'

let dir: string
let ts: TestServer

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pairpad-static-'))
  await mkdir(path.join(dir, 'public', 'assets'), { recursive: true })
  await writeFile(path.join(dir, 'public', 'index.html'), '<!doctype html><title>PairPad</title>')
  await writeFile(path.join(dir, 'public', 'assets', 'app-abc123.js'), 'console.log("app")')
  await writeFile(path.join(dir, 'secret.txt'), 'do not serve')
  ts = await startTestServer({ staticDir: path.join(dir, 'public') })
})

afterAll(async () => {
  await ts.server.close()
  await rm(dir, { recursive: true, force: true })
})

describe('static frontend', () => {
  it('serves index.html at the root', async () => {
    const res = await fetch(`${ts.httpUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('PairPad')
  })

  it('falls back to index.html for client-side routes', async () => {
    const res = await fetch(`${ts.httpUrl}/pad/abcd2345`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('PairPad')
  })

  it('serves fingerprinted assets with long-lived caching', async () => {
    const res = await fetch(`${ts.httpUrl}/assets/app-abc123.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe('console.log("app")')
  })

  it('returns 404 for a missing asset instead of the HTML shell', async () => {
    const res = await fetch(`${ts.httpUrl}/assets/missing.js`)
    expect(res.status).toBe(404)
  })

  it('does not serve files outside the static directory', async () => {
    for (const attempt of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt']) {
      const res = await rawGet(ts.port, attempt)
      expect(res, attempt).not.toContain('do not serve')
    }
  })

  it('keeps unknown API paths as JSON 404s', async () => {
    const res = await fetch(`${ts.httpUrl}/api/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('still serves the API alongside the frontend', async () => {
    const res = await fetch(`${ts.httpUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok' })
  })
})

// fetch() normalises ".." away before sending, so send the path verbatim.
async function rawGet(port: number, rawPath: string): Promise<string> {
  const { connect } = await import('node:net')
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
    let body = ''
    socket.on('data', (chunk) => (body += chunk.toString()))
    socket.on('end', () => resolve(body))
    socket.on('error', reject)
  })
}
