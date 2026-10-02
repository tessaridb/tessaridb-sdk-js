import { Socket, isIP } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { TlsError } from '../error.ts';
import type { Carrier } from './carrier.ts';
import { IoError } from './stream.ts';

/** Failures of the network itself, which are `IoError`; anything else that
 * ends a TLS dial before it is secured is the handshake's, and `TlsError`. */
const NETWORK = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

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

/**
 * Dial `host:port` over TLS 1.3, trusting `ca` (PEM) or the runtime's store.
 *
 * The certificate must chain to that trust and name `host`; an IP address is
 * checked against the certificate's IP entries, so no server name is sent for
 * one. Verification is not an option here — there is nothing to turn off.
 */
export function dialTls(
  host: string,
  port: number,
  timeout: number,
  ca: string | undefined,
): Promise<Carrier> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({
      host,
      port,
      ...(ca === undefined ? {} : { ca }),
      ...(isIP(host) === 0 ? { servername: host } : {}),
      minVersion: 'TLSv1.3',
      rejectUnauthorized: true,
    });
    const fail = (why: Error & { code?: string }): void => {
      socket.destroy();
      reject(
        why.code !== undefined && NETWORK.has(why.code)
          ? new IoError(`could not reach ${host}:${port} — ${why.message}`)
          : new TlsError(`TLS with ${host}:${port} failed: ${why.message}`),
      );
    };
    socket.setTimeout(timeout, () =>
      fail(
        Object.assign(new Error(`no answer within ${timeout} ms`), {
          code: 'ETIMEDOUT',
        }),
      ),
    );
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      socket.removeAllListeners('error');
      socket.setNoDelay(true);
      resolve(new OverTcp(socket));
    });
  });
}
