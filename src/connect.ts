import { Connection, type ConnectOptions } from './connection.ts';
import { dialTcp } from './wire/tcp.ts';
import { openWebSocket } from './wire/websocket.ts';

/**
 * Open a connection and exchange greetings.
 *
 * Over TCP to the wire port by default; over a WebSocket to the HTTP port's
 * `GET /wire` with `transport: 'websocket'`. The session is the same either way.
 */
export async function connect(options: ConnectOptions): Promise<Connection> {
  const timeout = options.timeout ?? 10_000;
  const carrier =
    options.transport === 'websocket'
      ? await openWebSocket(
          options.host,
          options.port,
          options.secure ?? false,
          timeout,
        )
      : await dialTcp(options.host, options.port, timeout);
  return Connection.over(carrier, options);
}
