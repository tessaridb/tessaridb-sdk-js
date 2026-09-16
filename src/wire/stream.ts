import { Socket } from 'node:net';
import { CEILING, HEADER_BYTES, TooLargeError, UnknownFrameError } from './frame.ts';

/** The stream ended mid-frame. Retry the transport. */
export class TruncatedError extends Error {
  override readonly name = 'TruncatedError';
}

/** The socket failed. Retry the transport. */
export class IoError extends Error {
  override readonly name = 'IoError';
}

export interface Frame {
  kind: number;
  body: Uint8Array;
}

/**
 * A framed reader over a socket.
 *
 * The distinction it exists to keep is between reading zero bytes **between**
 * frames, which is a clean goodbye, and reading zero bytes **inside** a header or
 * a body, which is truncation and is an error. Collapsing them makes a node that
 * hung up mid-answer look like one that finished.
 */
export class FrameStream {
  #socket: Socket;
  #chunks: AsyncIterator<Buffer>;
  #held: Uint8Array;
  #ended: boolean;

  constructor(socket: Socket) {
    this.#socket = socket;
    this.#chunks = socket[Symbol.asyncIterator]();
    this.#held = new Uint8Array(0);
    this.#ended = false;
  }

  async #pull(): Promise<boolean> {
    if (this.#ended) return false;
    let next;
    try {
      next = await this.#chunks.next();
    } catch (why) {
      throw new IoError(`the socket failed while reading: ${String(why)}`);
    }
    if (next.done) {
      this.#ended = true;
      return false;
    }
    const chunk = new Uint8Array(next.value);
    const grown = new Uint8Array(this.#held.length + chunk.length);
    grown.set(this.#held);
    grown.set(chunk, this.#held.length);
    this.#held = grown;
    return true;
  }

  /** `null` only at a clean boundary; anything short of `n` mid-read is truncation. */
  async #take(
    n: number,
    what: string,
    cleanEofAllowed: boolean,
  ): Promise<Uint8Array | null> {
    while (this.#held.length < n) {
      const more = await this.#pull();
      if (more) continue;
      if (this.#held.length === 0 && cleanEofAllowed) return null;
      throw new TruncatedError(
        `the stream ended while reading ${what}: wanted ${n} byte(s), ${this.#held.length} left`,
      );
    }
    const out = this.#held.slice(0, n);
    this.#held = this.#held.slice(n);
    return out;
  }

  async exactly(n: number, what: string): Promise<Uint8Array> {
    return (await this.#take(n, what, false))!;
  }

  /** Resolves `null` when the peer said goodbye between frames. */
  async next(known: ReadonlySet<number>): Promise<Frame | null> {
    const header = await this.#take(HEADER_BYTES, 'a frame header', true);
    if (header === null) return null;

    const kind = header[0]!;
    const length =
      ((header[1]! << 24) | (header[2]! << 16) | (header[3]! << 8) | header[4]!) >>> 0;

    // Refused before anything is allocated. A length from a stranger is not a promise.
    if (length > CEILING) throw new TooLargeError(length);

    // An unknown kind closes the connection. It is not skipped: a protocol that
    // ignores what it does not understand is one where a version mismatch looks
    // like silence. The body is drained first only so the error is about the
    // frame and not about the bytes after it.
    if (!known.has(kind)) {
      await this.exactly(length, 'the body of an unknown frame');
      throw new UnknownFrameError(kind);
    }

    const body = await this.exactly(length, 'a frame body');
    return { kind, body };
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket.write(bytes, (why) =>
        why
          ? reject(new IoError(`the socket failed while writing: ${why.message}`))
          : resolve(),
      );
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}
