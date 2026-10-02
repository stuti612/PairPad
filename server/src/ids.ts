import { randomInt } from 'node:crypto'

// No 0/o/1/l/i so IDs are easy to read aloud and retype.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const ID_LENGTH = 8
const ROOM_ID_PATTERN = /^[a-z0-9]{6,24}$/

export function generateRoomId(): string {
  let id = ''
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ALPHABET[randomInt(ALPHABET.length)]
  }
  return id
}

export function isValidRoomId(id: string): boolean {
  return ROOM_ID_PATTERN.test(id)
}
