import { HandshakeError, ProtocolError, RefusalError } from './error.ts';
import {
  FRAME,
  GREETING_BYTES,
  MAGIC,
  MAJOR,
  MINOR,
  frame,
  greeting,
} from './wire/frame.ts';
import type { Carrier } from './wire/carrier.ts';
import { FrameStream, IoError } from './wire/stream.ts';
import {
  readChange,
  readElsewhere,
  readRefusal,
  writeRequest,
  writeSubscribe,
} from './wire/message.ts';
import { readAnswer } from './wire/outcome.ts';
import type { Change, Credentials, Elsewhere } from './wire/message.ts';
import type { Outcome } from './wire/outcome.ts';
import type { Value } from './value.ts';

export interface ConnectOptions {
  host: string;
  /**
   * The node's wire port over TCP, or its **HTTP** port over a WebSocket — the
   * route `GET /wire` lives on the HTTP surface.
   */
  port: number;
  user?: string;
  password?: string;
  /** Milliseconds to wait for the socket and the greeting. */
  timeout?: number;
  /**
   * How the bytes travel. `'tcp'` reaches the wire port and is the default in
   * Node.js; `'websocket'` reaches `GET /wire` on the HTTP port and is the only
   * one a browser has. The protocol, the session and every answer are the same.
   */
  transport?: 'tcp' | 'websocket';
  /**
   * `wss://` rather than `ws://` — a node behind a TLS-terminating proxy. The
   * node serves no TLS itself. WebSocket only.
   */
  secure?: boolean;
}

/**
 * The answer to a statement.
 *
 * A redirect is deliberately not an error. It is an instruction, and a caller
 * that handles errors correctly — logs, retries a bounded number of times, gives
 * up — handles an instruction encoded as one incorrectly, every time, by
 * construction. So it arrives here as a value the caller must look at.
 */
export type Reply =
  { kind: 'answer'; outcomes: Outcome[] } | { kind: 'elsewhere'; redirect: Elsewhere };

const STATEMENT_FRAMES: ReadonlySet<number> = new Set([
  FRAME.answer,
  FRAME.refusal,
  FRAME.elsewhere,
]);
// A Subscribe is answered with a Refusal when the node declines it — an
// unselected database is the common case — so the refusal must be a known kind
// here. Leaving it out turns "your session has no database" into "unknown frame
// kind 3", which tells the caller to upgrade the client.
const CHANGE_FRAMES: ReadonlySet<number> = new Set([FRAME.change, FRAME.refusal]);

/**
 * One connection is one session.
 *
 * `USE NAMESPACE prod;` is still in force in the next statement on this
 * connection — that is what a connection means. Two connections are two sessions
 * and share nothing but the store.
 */
export class Connection {
  #stream: FrameStream;
  #credentials: Credentials | undefined;
  #peerMinor: number;
  #subscribed: boolean;
  #busy: boolean;

  private constructor(
    stream: FrameStream,
    peerMinor: number,
    credentials?: Credentials,
  ) {
    this.#stream = stream;
    this.#credentials = credentials;
    this.#peerMinor = peerMinor;
    this.#subscribed = false;
    this.#busy = false;
  }

  /** The peer's minor. Used for one thing only: not sending what an older peer cannot read. */
  get peerMinor(): number {
    return this.#peerMinor;
  }

  /**
   * Greet a node over `carrier` and hold the session that follows.
   *
   * `connect()` is the usual way in; this is the seam it uses, open for a caller
   * that brings its own carrier.
   */
  static async over(carrier: Carrier, options: ConnectOptions): Promise<Connection> {
    const stream = new FrameStream(carrier);
    await stream.write(greeting());

    // The magic is judged on its own four bytes, before the version bytes are
    // read. A peer that is not a node owes nothing — it may send three bytes of
    // an HTTP request line and hang up — and waiting for all six first reports
    // that as a truncated stream, which sends whoever reads the error to the
    // network when the answer is that the address is wrong.
    const magic = await stream.exactly(MAGIC.length, 'the greeting magic');
    for (let i = 0; i < MAGIC.length; i++) {
      if (magic[i] !== MAGIC[i]) {
        stream.close();
        throw new HandshakeError(
          `${options.host}:${options.port} is not a TessariDB node — it did not answer with TESS`,
        );
      }
    }

    const version = await stream.exactly(
      GREETING_BYTES - MAGIC.length,
      'the greeting version',
    );
    const major = version[0]!;
    const minor = version[1]!;
    if (major !== MAJOR) {
      stream.close();
      throw new HandshakeError(
        `protocol major ${major} found, ${MAJOR} supported — upgrade one side`,
      );
    }

    const credentials =
      options.user === undefined
        ? undefined
        : { user: options.user, password: options.password ?? '' };
    return new Connection(stream, minor, credentials);
  }

  /**
   * Run a script and read its answer.
   *
   * A refusal throws: the store said no in its own words, and those words are
   * carried through verbatim rather than reworded here — the session already
   * names the place in the script, and rewording makes this client a second
   * author for one error. A refusal does not close the connection; a client that
   * mistyped a statement has not stopped being a client.
   */
  async execute(script: string, parameters?: Map<string, Value>): Promise<Reply> {
    if (this.#subscribed) {
      throw new ProtocolError(
        'this connection is subscribed and no longer answers statements — open a second connection',
      );
    }
    if (this.#busy) {
      throw new ProtocolError('a statement is already in flight on this connection');
    }
    this.#busy = true;
    try {
      const body = writeRequest(script, parameters ?? new Map(), this.#credentials);
      await this.#stream.write(frame(FRAME.request, body));

      const reply = await this.#stream.next(STATEMENT_FRAMES);
      if (reply === null) {
        throw new IoError('the node closed the connection without answering');
      }
      switch (reply.kind) {
        case FRAME.answer:
          return { kind: 'answer', outcomes: readAnswer(reply.body) };
        case FRAME.elsewhere:
          return { kind: 'elsewhere', redirect: readElsewhere(reply.body) };
        case FRAME.refusal:
          throw new RefusalError('refused', readRefusal(reply.body));
        default:
          throw new ProtocolError(
            `frame kind ${reply.kind} is not an answer to a request`,
          );
      }
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Subscribe to changes. **This consumes the connection** — after a Subscribe
   * frame the socket delivers changes and no longer answers statements, and a
   * client that wants both opens two connections. An API that hid this would be
   * promising a multiplexing the protocol does not perform.
   *
   * `from` is inclusive. Pass the sequence you last handled and this method adds
   * the one for you, because getting that arithmetic wrong is silent in both
   * directions: too low redelivers, too high reports being caught up.
   *
   * The node ends a subscription that stops being read after **30 seconds**.
   * Nothing is lost — the log is the buffer — but that is why `resumeAfter` is
   * the parameter rather than a raw position: reconnecting is the normal path,
   * not the exceptional one.
   *
   * A feed over a split table resumes by `cursor` instead — the `cursor` of the
   * last change handled, sent back as it came. The node resumes after that
   * change, so no arithmetic is owed.
   */
  async *changes(
    options: {
      resumeAfter?: bigint;
      fromStart?: boolean;
      table?: string;
      cursor?: string;
    } = {},
  ): AsyncGenerator<Change> {
    if (this.#subscribed)
      throw new ProtocolError('this connection is already subscribed');
    this.#subscribed = true;

    const from = options.fromStart
      ? 0n
      : options.resumeAfter === undefined
        ? 0n
        : options.resumeAfter + 1n;

    await this.#stream.write(
      frame(FRAME.subscribe, writeSubscribe(from, options.table, options.cursor)),
    );

    for (;;) {
      const next = await this.#stream.next(CHANGE_FRAMES);
      if (next === null) return;
      if (next.kind === FRAME.refusal) {
        throw new RefusalError('refused', readRefusal(next.body));
      }
      yield readChange(next.body);
    }
  }

  close(): void {
    this.#stream.close();
  }
}
