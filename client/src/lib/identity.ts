export interface Identity {
  name: string
  color: string
  /** True once you choose a color yourself; a random one may be swapped to avoid a clash. */
  colorPicked: boolean
}

// Light enough to read on the dark background and to carry dark text on top.
export const COLORS = [
  { name: 'Red', value: '#f87171' },
  { name: 'Orange', value: '#fb923c' },
  { name: 'Amber', value: '#fbbf24' },
  { name: 'Lime', value: '#a3e635' },
  { name: 'Green', value: '#34d399' },
  { name: 'Cyan', value: '#22d3ee' },
  { name: 'Blue', value: '#60a5fa' },
  { name: 'Violet', value: '#a78bfa' },
  { name: 'Fuchsia', value: '#e879f9' },
  { name: 'Pink', value: '#f472b6' },
] as const

export const MAX_NAME_LENGTH = 24
export const FALLBACK_NAME = 'Anonymous'
export const FALLBACK_COLOR = '#9aa0b2'

const ADJECTIVES = [
  'Quiet', 'Brisk', 'Clever', 'Mellow', 'Nimble', 'Sunny', 'Curious', 'Bold',
  'Gentle', 'Swift', 'Witty', 'Calm', 'Lucky', 'Keen', 'Jolly', 'Brave',
]
const ANIMALS = [
  'Otter', 'Falcon', 'Lynx', 'Heron', 'Badger', 'Koala', 'Gecko', 'Panda',
  'Finch', 'Marten', 'Tapir', 'Walrus', 'Ibis', 'Lemur', 'Puffin', 'Wombat',
]

const STORAGE_KEY = 'pairpad:identity'
const HEX_COLOR = /^#[0-9a-f]{6}$/i

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

export function randomIdentity(): Identity {
  return {
    name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
    color: pick(COLORS).value,
    colorPicked: false,
  }
}

/** A random palette color nobody in `taken` is using, or null if they are all in use. */
export function freeColor(taken: ReadonlySet<string>): string | null {
  const free = COLORS.filter(({ value }) => !taken.has(value))
  return free.length > 0 ? pick(free).value : null
}

/**
 * Normalises a name from user input or from another client. Presence data
 * comes straight from other people's browsers, so it is never trusted as-is.
 */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim()
  return name === '' ? null : name
}

export function cleanColor(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : null
}

/** Your name and color are remembered in this browser across pads and reloads. */
export function loadIdentity(): Identity {
  const fresh = randomIdentity()
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (stored && typeof stored === 'object') {
      const { name, color, colorPicked } = stored as Record<string, unknown>
      const storedColor = cleanColor(color)
      return {
        name: cleanName(name) ?? fresh.name,
        color: storedColor ?? fresh.color,
        colorPicked: storedColor !== null && colorPicked === true,
      }
    }
  } catch {
    // Storage can be unavailable (private mode, blocked cookies): use a fresh identity.
  }
  return fresh
}

export function saveIdentity(identity: Identity): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
  } catch {
    // Not being able to remember the name is not worth interrupting anyone for.
  }
}

export function initials(name: string): string {
  const words = name.split(' ').filter(Boolean)
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words
  return letters.map((word) => [...word][0]!.toUpperCase()).join('')
}
