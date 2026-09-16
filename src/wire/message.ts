import { ByteReader, ByteWriter } from '../codec/bytes.ts';
import { writeValue } from '../codec/encode.ts';
import { readValue } from '../codec/decode.ts';
import { ProtocolError } from '../error.ts';
import type { Value } from '../value.ts';

export interface Credentials {
  user: string;
  password: string;
}

/**
 * A Request body.
 *
 * Parameter values travel in the value codec, **never as text**. This is the
 * reason the wire protocol exists: a value the server has to parse is a value
 * that can be parsed as something else, and binding after parsing exists
 * precisely to make that impossible. A client that formats parameters into the
 * script destroys the property invisibly, because the resulting script still
 * looks correct.
 */
export function writeRequest(
  script: string,
  parameters: Map<string, Value>,
  credentials?: Credentials,
): Uint8Array {
  const w = new ByteWriter();
  w.text(script);
  if (credentials) {
    w.u8(1);
    w.text(credentials.user);
    w.text(credentials.password);
  } else {
    // A store with no users declared is open and runs anything, which is what
    // keeps an empty one usable. A closed store's refusal comes from the session.
    w.u8(0);
  }
  w.u32(parameters.size);
  for (const [name, value] of parameters) {
    w.text(name);
    const body = new ByteWriter();
    writeValue(body, value);
    w.lenbytes(body.finish());
  }
  return w.finish();
}

/**
 * A Subscribe body. `from` is **inclusive**, and the arithmetic is the client's
 * to own: a subscriber stores the sequence of the last change it handled and
 * resumes with that plus one. Resuming with the position already handled delivers
 * it twice; resuming with one not yet reached reports being caught up. Both are
 * silent, which is why this library owns the arithmetic rather than documenting it.
 */
export function writeSubscribe(from: bigint, table?: string): Uint8Array {
  const w = new ByteWriter();
  w.u64(from);
  if (table === undefined) {
    w.u8(0);
  } else {
    w.u8(1);
    w.text(table);
  }
  return w.finish();
}

export type Fate = 'written' | 'removed';

export interface Change {
  /** Shared by every change of one commit — the unit they were written as, and what a subscriber stores to resume from. */
  sequence: bigint;
  /** Named, not identified: an id is meaningless outside the process that minted it. */
  table: string;
  identity: string;
  fate: Fate;
  value?: Value;
}

export function readChange(body: Uint8Array): Change {
  const r = new ByteReader(body);
  const sequence = r.u64('change sequence');
  const table = r.text('change table');
  const identity = r.text('change identity');
  const fate = r.u8('change fate');
  if (fate === 1) return { sequence, table, identity, fate: 'removed' };
  if (fate !== 0) throw new ProtocolError(`malformed change fate byte ${fate}`);
  const bytes = r.lenbytes('change value');
  const inner = new ByteReader(bytes);
  const value = readValue(inner);
  if (!inner.exhausted) {
    throw new ProtocolError(
      `${inner.remaining} trailing byte(s) after a change's value`,
    );
  }
  return { sequence, table, identity, fate: 'written', value };
}

/**
 * `settled` may be remembered and used to update a routing map. `transient`
 * **must not be** — it answers this request and nothing after it, and a client
 * that remembered it would pin its map to an arrangement that was never meant to
 * outlast the request.
 */
export type Settlement = 'settled' | 'transient';

/**
 * A redirect, which is not a failure.
 *
 * It is an *instruction*, and a client that handles failures correctly — logs
 * them, retries a bounded number of times, gives up — handles an instruction
 * encoded as one incorrectly, every time, by construction. So it is its own frame
 * kind, and this client never surfaces it through the error path.
 *
 * A minimal client may report it and stop. What it may not do is treat it as a
 * transport failure and retry the same node, or silently return an empty answer.
 */
export interface Elsewhere {
  /** Who to expect there — what makes the redirect checkable on arrival. */
  node: Uint8Array;
  /** The leadership the **named** node last claimed, which is what tells a loop from progress. */
  epoch: bigint;
  settlement: Settlement;
  endpoint: string;
}

export function readElsewhere(body: Uint8Array): Elsewhere {
  const r = new ByteReader(body);
  const node = r.fixed(16, 'redirect node');
  const epoch = r.u64('redirect epoch');
  const byte = r.u8('redirect settlement');
  // Zero is deliberately unassigned: it is what a truncated or zeroed buffer
  // holds, and giving it a meaning would let corruption decode as a value.
  if (byte !== 1 && byte !== 2) {
    throw new ProtocolError(`malformed redirect settlement byte ${byte}`);
  }
  const settlement: Settlement = byte === 1 ? 'settled' : 'transient';
  return { node, epoch, settlement, endpoint: r.text('redirect endpoint') };
}

/** A Refusal body is the store's own message, whole, with no length prefix — and carried through verbatim. */
export function readRefusal(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ProtocolError('invalid UTF-8 in a refusal message');
  }
}
