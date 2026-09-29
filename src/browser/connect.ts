import { Connection, type ConnectOptions } from '../connection.ts';
import { ProtocolError } from '../error.ts';
import { openWebSocket } from '../wire/websocket.ts';

/**
 * Open a connection from a browser: always a WebSocket to the node's HTTP port
 * at `GET /wire`, because a browser has no other way to reach the wire protocol.
 */
export async function connect(options: ConnectOptions): Promise<Connection> {
  if (options.transport === 'tcp') {
    throw new ProtocolError(
      "a browser cannot open a TCP socket — connect with transport 'websocket' to the node's HTTP port",
    );
  }
  const carrier = await openWebSocket(
    options.host,
    options.port,
    options.secure ?? false,
    options.timeout ?? 10_000,
  );
  return Connection.over(carrier, options);
}
