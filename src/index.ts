/**
 * A client for TessariDB, written from the protocol specification.
 *
 * This package links nothing from the database's own repository, in this language
 * or any other. What it depends on is the frame layout, the tag numbers, the
 * version byte and the value codec — all of which are specified, and the
 * specification is the interface.
 *
 * ## Two transports, and the choice is forced
 *
 * A node serves two surfaces and neither carries everything. Statements and
 * change subscriptions go over the **wire protocol**, because it carries the
 * store's full model of seventeen value types. Objects, files, backup and the
 * operational routes go over **HTTP**, because nothing else serves them.
 *
 * A caller never picks a transport per call. Routing statements over HTTP would
 * work, reach everything, and silently narrow every result — JSON carries six
 * types — and nothing at the call site would show what was lost.
 *
 * ## In a browser
 *
 * A browser cannot open a TCP socket, so the same wire protocol also travels
 * over a WebSocket to the node's HTTP port at `GET /wire` — the same frames and
 * the same seventeen types, not the HTTP half and its narrowing. Pass
 * `transport: 'websocket'`, or import `@tessaridb/client/browser`, whose
 * `connect` has no other transport.
 *
 * ## There is no TLS on the wire protocol
 *
 * Credentials travel as given. Run this on a protected network, or behind
 * something that terminates TLS — which, for a page served over `https://`, is
 * also what makes `wss://` (`secure: true`) possible at all.
 */

export * from './portable.ts';
export { connect } from './connect.ts';
