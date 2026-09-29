/**
 * `@tessaridb/client` for a browser.
 *
 * Everything the Node.js entry offers except the TCP transport, which a browser
 * cannot open: `connect` here always reaches the node's HTTP port at `GET /wire`,
 * where the same wire protocol travels over a WebSocket. Nothing this entry
 * imports, by any path, is a Node.js module.
 *
 * There is no TLS on the node. A page served over `https://` cannot open `ws://`,
 * so production use means a TLS-terminating proxy and `secure: true`.
 */
export * from './portable.ts';
export { connect } from './browser/connect.ts';
