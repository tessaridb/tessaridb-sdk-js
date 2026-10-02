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
/**
 * TLS with the node failed — the handshake, its name, its chain (protocol §1.1).
 *
 * The transport class, and deliberately not an `IoError`: nothing about the next
 * attempt at the same node would differ, so it is not retried.
 */
export class TlsError extends Error {
  override readonly name = 'TlsError';
}

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

/**
 * The node's greeting names a minor below the one a call needs, so nothing was
 * sent: a frame an older node does not know closes the connection.
 */
export class NodeTooOldError extends Error {
  override readonly name = 'NodeTooOldError';
  readonly found: number;
  readonly needed: number;

  constructor(found: number, needed: number) {
    super(
      `this node speaks protocol minor ${found}; this call needs ${needed} or later`,
    );
    this.found = found;
    this.needed = needed;
  }
}

/**
 * Three redirects followed and still no answer (protocol §3.12). Going on would
 * not tell a loop from a cluster moving faster than the request.
 */
export class RedirectLoopError extends Error {
  override readonly name = 'RedirectLoopError';
  readonly hops: number;

  constructor(hops: number) {
    super(`still redirected after ${hops} hops; stopping rather than going round`);
    this.hops = hops;
  }
}

/**
 * A redirect dated by an older leadership than one this request already
 * followed: it was decided before that one, and points at the past.
 */
export class StaleRedirectError extends Error {
  override readonly name = 'StaleRedirectError';
  readonly epoch: bigint;
  readonly floor: bigint;

  constructor(epoch: bigint, floor: bigint) {
    super(`redirected under epoch ${epoch} after following epoch ${floor}`);
    this.epoch = epoch;
    this.floor = floor;
  }
}

/** The address a redirect named answered as a different node; the request was not sent there. */
export class WrongNodeError extends Error {
  override readonly name = 'WrongNodeError';
  readonly expected: Uint8Array;

  constructor(expected: Uint8Array) {
    super('the redirect named another node than the one that answered there');
    this.expected = expected;
  }
}

/**
 * The session's namespace or database is not a plain name, so it is not selected
 * again on the node a redirect named: a name is grammar, and this client does not
 * quote one into a script.
 */
export class NotFollowableError extends Error {
  override readonly name = 'NotFollowableError';
  readonly selected: string;

  constructor(selected: string) {
    super(
      `cannot follow: '${selected}' is not a plain name to select on the other node`,
    );
    this.selected = selected;
  }
}
