// Wire protocol shared with the y-websocket client provider: every binary
// frame starts with a varuint message type, followed by a y-protocols payload.
export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_QUERY_AWARENESS = 3

// Application close codes (4000-4999 is the range reserved for apps).
// 4400-4499 mean "do not retry": the y-websocket client stops reconnecting
// when it sees one. 4500 and up are temporary, and the client retries.
export const CLOSE_MALFORMED = 4400
export const CLOSE_TOO_LARGE = 4413
export const CLOSE_ROOM_FULL = 4429
export const CLOSE_LOAD_FAILED = 4500

// Name of the shared Y.Text that holds the pad contents.
export const TEXT_KEY = 'content'
