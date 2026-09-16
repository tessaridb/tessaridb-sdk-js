/**
 * The errors this client raises.
 *
 * The protocol separates three things a caller must be able to tell apart: a
 * connection that failed, a message that did not conform, and a statement the
 * node refused. Collapsing them into one error type makes a wrong password and a
 * broken cable look the same at the call site, and only one of them is worth a
 * retry.
 */

/** The peer is reachable but is not speaking this protocol, or not this major. */
export class HandshakeError extends Error {
  override readonly name = 'HandshakeError';
}

/** The bytes did not conform to the specification. Never a retry. */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

/**
 * The node understood the request and declined it — a syntax error, a permission,
 * a constraint. The message is the store's own words and is not reworded here.
 */
export class RefusalError extends Error {
  override readonly name = 'RefusalError';
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
