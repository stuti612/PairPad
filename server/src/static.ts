import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type http from 'node:http'
import path from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Serves the built frontend. Paths that are not files fall back to
 * index.html so client-side routes like /pad/<id> work on a hard refresh.
 * Returns false if nothing could be served.
 */
export async function serveStatic(
  staticDir: string,
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return false
  }
  const root = path.resolve(staticDir)
  const requested = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`)
  // Never serve anything outside the static directory.
  if (requested !== root && !requested.startsWith(root + path.sep)) return false

  if (await isFile(requested)) {
    return sendFile(requested, req, res)
  }
  // A missing asset should 404 rather than return the HTML shell.
  if (path.extname(requested) !== '') return false

  const index = path.join(root, 'index.html')
  if (await isFile(index)) {
    return sendFile(index, req, res)
  }
  return false
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function sendFile(
  file: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const { size } = await stat(file)
  // Vite fingerprints everything under /assets, so it can be cached forever.
  const immutable = file.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
  return true
}
