/**
 * What a connection's bytes travel over.
 *
 * Two carriers exist: a TCP socket to the node's wire port (Node.js only), and a
 * WebSocket to the node's HTTP port at `GET /wire`, which is how a browser — which
 * cannot open a TCP socket — reaches the same protocol. The bytes are identical
 * over both; only how they arrive differs, and nothing above this interface can
 * tell which one it has.
 */
export interface Carrier {
  /**
   * The next bytes the node sent, in however many pieces they arrived, or `null`
   * once the node has closed. A carrier that failed rejects with `IoError`.
   *
   * Whether a close was a clean goodbye or truncation is not decided here: that
   * depends on whether it fell between frames, which only the frame reader knows.
   */
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}
