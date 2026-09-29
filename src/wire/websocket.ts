import type { Carrier } from './carrier.ts';
import { IoError } from './stream.ts';

/**
 * The address of a node's `GET /wire` route: its **HTTP** port, not its wire port.
 *
 * `secure` means `wss://`, which is a TLS-terminating proxy in front of the node —
 * the node itself serves no TLS, and a page loaded over `https://` cannot open a
 * `ws://` socket at all.
 */
export function wireUrl(host: string, port: number, secure: boolean): string {
  const at = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${secure ? 'wss' : 'ws'}://${at}:${port}/wire`;
}

/**
 * The wire protocol over a WebSocket, using the platform's own `WebSocket` — a
 * browser's, or Node's since 22. No dependency.
 *
 * Binary messages are the byte stream and their boundaries mean nothing, so each
 * one is handed on as it came and the frame reader reassembles.
 *
 * A browser's `WebSocket` cannot stop reading: a subscriber that stops consuming
 * changes accumulates them here, in memory, where over TCP the socket would fill
 * and the node would drop the subscriber after 30 seconds. Consume what you
 * subscribe to.
 */
class OverWebSocket implements Carrier {
  #socket: WebSocket;
  #held: Uint8Array[] = [];
  #ended = false;
  #failure: IoError | undefined;
  #wake: (() => void) | undefined;

  constructor(socket: WebSocket, url: string) {
    this.#socket = socket;
    socket.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        this.#held.push(new Uint8Array(event.data));
      } else {
        this.#failure ??= new IoError(
          `${url} sent a text message, which the wire protocol never carries`,
        );
        socket.close();
      }
      this.#notify();
    };
    socket.onerror = () => {
      this.#failure ??= new IoError(`the websocket to ${url} failed`);
      this.#notify();
    };
    socket.onclose = (event: CloseEvent) => {
      // 1000 is the node ending the session and 1005 a close with no code; any
      // other code is the node refusing something, and says what.
      if (event.code !== 1000 && event.code !== 1005) {
        this.#failure ??= new IoError(
          `${url} closed the socket with ${event.code}${event.reason ? `: ${event.reason}` : ''}`,
        );
      }
      this.#ended = true;
      this.#notify();
    };
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async read(): Promise<Uint8Array | null> {
    for (;;) {
      const next = this.#held.shift();
      if (next !== undefined) return next;
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#ended) return null;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        this.#failure ??
          new IoError('the websocket is closed and cannot be written to'),
      );
    }
    this.#socket.send(bytes);
    return Promise.resolve();
  }

  close(): void {
    this.#socket.close();
  }
}

/** Open `ws://host:port/wire` (or `wss://`), and resolve once it is open. */
export function openWebSocket(
  host: string,
  port: number,
  secure: boolean,
  timeout: number,
): Promise<Carrier> {
  const url = wireUrl(host, port, secure);
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (why) {
      reject(new IoError(`could not open ${url} — ${String(why)}`));
      return;
    }
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      socket.close();
      reject(new IoError(`could not reach ${url} — no answer within ${timeout} ms`));
    }, timeout);
    socket.onerror = () => {
      clearTimeout(timer);
      reject(
        new IoError(
          `could not reach ${url} — refused, or the node does not serve the wire protocol there`,
        ),
      );
    };
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(new OverWebSocket(socket, url));
    };
  });
}
