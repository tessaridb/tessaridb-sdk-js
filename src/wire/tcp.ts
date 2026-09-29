import { Socket } from 'node:net';
import type { Carrier } from './carrier.ts';
import { IoError } from './stream.ts';

/** A TCP socket to a node's wire port. Node.js only. */
class OverTcp implements Carrier {
  #socket: Socket;
  #chunks: AsyncIterator<Buffer>;

  constructor(socket: Socket) {
    this.#socket = socket;
    this.#chunks = socket[Symbol.asyncIterator]();
  }

  async read(): Promise<Uint8Array | null> {
    let next;
    try {
      next = await this.#chunks.next();
    } catch (why) {
      throw new IoError(`the socket failed while reading: ${String(why)}`);
    }
    return next.done ? null : new Uint8Array(next.value);
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

/** Dial `host:port` over TCP. */
export function dialTcp(host: string, port: number, timeout: number): Promise<Carrier> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const fail = (why: string): void => {
      socket.destroy();
      reject(new IoError(`could not reach ${host}:${port} — ${why}`));
    };
    socket.setTimeout(timeout, () => fail(`no answer within ${timeout} ms`));
    socket.once('error', (why) => fail(why.message));
    socket.connect(port, host, () => {
      socket.setTimeout(0);
      socket.removeAllListeners('error');
      // Statements are small and answers are awaited; Nagle only adds latency here.
      socket.setNoDelay(true);
      resolve(new OverTcp(socket));
    });
  });
}
