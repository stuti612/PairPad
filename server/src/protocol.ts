// Wire protocol shared with the y-websocket client provider: every binary
// frame starts with a varuint message type, followed by a y-protocols payload.
export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_QUERY_AWARENESS = 3

// Application close codes (4000-4999 is the range reserved for apps).
export const CLOSE_MALFORMED = 4400
export const CLOSE_LOAD_FAILED = 4500

// Name of the shared Y.Text that holds the pad contents.
export const TEXT_KEY = 'content'
