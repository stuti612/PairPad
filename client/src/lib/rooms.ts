// Must match the server's rule in server/src/ids.ts.
const ROOM_ID_PATTERN = /^[a-z0-9]{6,24}$/

export function isValidRoomId(id: string): boolean {
  return ROOM_ID_PATTERN.test(id)
}

export async function createRoom(): Promise<string> {
  const res = await fetch('/api/rooms', { method: 'POST' })
  if (!res.ok) throw new Error(`Server responded with ${res.status}`)
  const { id } = (await res.json()) as { id: string }
  return id
}

export function padPath(roomId: string): string {
  return `/pad/${roomId}`
}

/** Base URL the y-websocket provider appends the room ID to. */
export function websocketBaseUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws`
}
