/**
 * The text of JSON responses Inferlo builds itself, so a Node.js server can send it in one write with a
 * Content-Length instead of reading the Response body stream chunk by chunk. A response that is copied, or
 * whose body was read, is not in the map and is streamed as usual.
 */
export const knownBodies = new WeakMap<Response, string>();
