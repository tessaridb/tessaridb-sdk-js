import { Connection, type ConnectOptions } from './connection.ts';
import { ProtocolError } from './error.ts';
import { dialTcp } from './wire/tcp.ts';
import { openWebSocket } from './wire/websocket.ts';

/**
 * Open a connection and exchange greetings.
 *
 * Over TCP to the wire port by default; over a WebSocket to the HTTP port's
 * `GET /wire` with `transport: 'websocket'`. The session is the same either way.
 */
export async function connect(options: ConnectOptions): Promise<Connection> {
  // Following a redirect dials the address it names, which is a wire address:
  // a TCP connection can follow one, a WebSocket cannot.
  const dial =
    options.transport === 'websocket'
      ? undefined
      : (endpoint: string): Promise<Connection> => {
          const at = endpoint.lastIndexOf(':');
          const port = Number(endpoint.slice(at + 1));
          if (at <= 0 || !Number.isInteger(port)) {
            return Promise.reject(
              new ProtocolError(
                `a redirect named '${endpoint}', which is not host:port`,
              ),
            );
          }
          return connect({ ...options, host: endpoint.slice(0, at), port });
        };
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
  return Connection.over(carrier, options, dial);
}
