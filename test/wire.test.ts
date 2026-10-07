import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ByteWriter } from '../src/codec/bytes.ts';
import { readAnswer } from '../src/wire/outcome.ts';
import { readChange, readProgress, writeSubscribe } from '../src/wire/message.ts';
import { createServer } from 'node:net';
import { writeValue } from '../src/codec/encode.ts';
import { connect } from '../src/connect.ts';
import { NodeTooOldError, ProtocolError } from '../src/error.ts';
import type { Value } from '../src/value.ts';
import { hexToBytes, readCorpus } from './corpus.ts';

/** One outcome: `u32` length (tag included), `u8` tag, then the rest. */
function answerOf(...outcomes: Uint8Array[]): Uint8Array {
  const w = new ByteWriter();
  w.u32(outcomes.length);
  for (const o of outcomes) {
    w.u32(o.length);
    w.fixed(o);
  }
  return w.finish();
}

const done = (): Uint8Array => Uint8Array.from([0]);

test('an unknown outcome is surfaced, stepped over, and does not stop the answer', () => {
  // A newer node may introduce an outcome kind anywhere in an answer. The length
  // in front is what makes that a minor change rather than a breaking one.
  const newKind = Uint8Array.from([0x5a, 1, 2, 3, 4, 5]);
  const outcomes = readAnswer(answerOf(done(), newKind, done()));

  assert.equal(outcomes.length, 3, 'reading MUST NOT stop at the first unknown');
  assert.deepEqual(outcomes[0], { kind: 'done' });
  assert.equal(outcomes[1]?.kind, 'unknown');
  assert.equal((outcomes[1] as { tag: number }).tag, 0x5a);
  assert.deepEqual(
    outcomes[2],
    { kind: 'done' },
    'the outcome after an unknown is still read',
  );
});

test('a recognised outcome may not read past its own length', () => {
  // A Keys outcome claiming two keys inside a length that holds one.
  const body = new ByteWriter();
  body.u8(3);
  body.u32(2);
  body.text('only-one');
  assert.throws(() => readAnswer(answerOf(body.finish())), /truncated/);
});

test('absent exactness is unstated, and unstated is not exact', () => {
  // A Records outcome from a node built before the field existed: the body ends
  // after the records. That is a node with nothing to say, not a truncation.
  const body = new ByteWriter();
  body.u8(1); // tag: records
  body.u8(1); // access path: index
  body.u32(0); // names
  body.u32(0); // records
  const [outcome] = readAnswer(answerOf(body.finish()));

  assert.equal(outcome?.kind, 'records');
  const records = outcome as {
    exactness: { kind: string };
    suggestion: { kind: string };
  };
  assert.equal(
    records.exactness.kind,
    'unstated',
    'absence here is NOT the default — reading it as exact puts a promise in the node’s mouth',
  );
  assert.equal(records.suggestion.kind, 'not-consulted');
});

test('a stated exactness of 1 carries the node’s own reason', () => {
  const body = new ByteWriter();
  body.u8(1);
  body.u8(4); // approximate
  body.u32(0);
  body.u32(0);
  body.u32(0); // notes
  body.u8(0); // only
  body.u8(1); // not exact
  body.text('the index was capped');
  const [outcome] = readAnswer(answerOf(body.finish()));
  const records = outcome as {
    path: string;
    exactness: { kind: string; reason?: string };
  };
  assert.equal(records.path, 'approximate');
  assert.deepEqual(records.exactness, {
    kind: 'inexact',
    reason: 'the index was capped',
  });
});

test('an unrecognised access path reads as scan', () => {
  const body = new ByteWriter();
  body.u8(1);
  body.u8(200); // a path this build has no name for
  body.u32(0);
  body.u32(0);
  const [outcome] = readAnswer(answerOf(body.finish()));
  assert.equal(
    (outcome as { path: string }).path,
    'scan',
    'the honest answer for an unnamed path: the one path that promises nothing',
  );
});

/** A removed-record change body (§3.8), with an optional trailing cursor. */
function removedChange(cursor?: string): Uint8Array {
  const w = new ByteWriter();
  w.u64(7n);
  w.text('orders');
  w.text('orders:1');
  w.u8(1);
  if (cursor !== undefined) w.text(cursor);
  return w.finish();
}

test('a change from a split table carries its cursor and a plain one carries none', () => {
  assert.equal(readChange(removedChange()).cursor, undefined);
  const split = readChange(removedChange('0:7,2:3'));
  assert.equal(split.fate, 'removed');
  assert.equal(split.cursor, '0:7,2:3');
});

test('a subscribe sends its cursor last and only when it has one', () => {
  const plain = writeSubscribe(0n, 'orders');
  const resumed = writeSubscribe(0n, 'orders', '0:7,2:3');
  assert.deepEqual(resumed.subarray(0, plain.length), plain);
  assert.equal(new TextDecoder().decode(resumed.subarray(plain.length + 4)), '0:7,2:3');
});

test('a condition follows an empty cursor, its parameters one object (§3.7)', () => {
  const parameters = new Map<string, Value>([
    ['least', { kind: 'integer', value: 100n }],
  ]);
  const narrowed = writeSubscribe(7n, 'orders', undefined, {
    text: 'total > $least',
    parameters,
  });
  const want = new ByteWriter();
  want.u64(7n);
  want.u8(1);
  want.text('orders');
  want.text('');
  want.text('total > $least');
  const object = new ByteWriter();
  writeValue(object, { kind: 'object', fields: parameters });
  want.lenbytes(object.finish());
  assert.deepEqual(narrowed, want.finish());

  const split = writeSubscribe(0n, 'orders', '1.1:d=12', {
    text: 'open',
    parameters: new Map(),
  });
  const resumed = new ByteWriter();
  resumed.u64(0n);
  resumed.u8(1);
  resumed.text('orders');
  resumed.text('1.1:d=12');
  resumed.text('open');
  const empty = new ByteWriter();
  writeValue(empty, { kind: 'object', fields: new Map() });
  resumed.lenbytes(empty.finish());
  assert.deepEqual(split, resumed.finish());
});

test('every progress vector decodes exactly or is refused (§3.15)', () => {
  const vectors = readCorpus('frames-v1.json')['progress'];
  assert.ok(
    Array.isArray(vectors) && vectors.length >= 5,
    'the corpus carries progress vectors',
  );
  for (const vector of vectors as Array<Record<string, unknown>>) {
    const body = hexToBytes(String(vector['body_hex']));
    if ('malformed' in vector) {
      assert.throws(() => readProgress(body), ProtocolError, String(vector['name']));
      continue;
    }
    const decoded = vector['decoded'] as { sequence: string; cursor: string | null };
    const got = readProgress(body);
    assert.equal(got.sequence, BigInt(decoded.sequence), String(vector['name']));
    assert.equal(got.cursor ?? null, decoded.cursor, String(vector['name']));
  }
});

/** A node on loopback that greets with `minor`, records what it is sent, and says `said`. */
async function nodeOf(
  minor: number,
  said: Uint8Array = new Uint8Array(),
): Promise<{ port: number; heard: Promise<Uint8Array> }> {
  let resolveHeard: (bytes: Uint8Array) => void = () => {};
  const heard = new Promise<Uint8Array>((resolve) => {
    resolveHeard = resolve;
  });
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => {
      resolveHeard(new Uint8Array(Buffer.concat(chunks)).subarray(6));
      server.close();
    });
    socket.write(Uint8Array.from([0x54, 0x45, 0x53, 0x53, 1, minor]));
    socket.end(said);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, heard };
}

test('a condition is not sent to a node before minor four', async () => {
  const node = await nodeOf(3);
  const conn = await connect({ host: '127.0.0.1', port: node.port });
  await assert.rejects(
    conn.changes({ table: 'orders', condition: 'open' }).next(),
    (error: unknown) =>
      error instanceof NodeTooOldError && error.found === 3 && error.needed === 4,
  );
  conn.close();
  assert.equal(
    (await node.heard).length,
    0,
    'nothing reached a node that would misread it',
  );
});

test('a narrowed feed hands over progress beside its changes', async () => {
  const progress = new ByteWriter();
  progress.u64(41n);
  progress.text('1.1:d=12');
  const change = new ByteWriter();
  change.u64(42n);
  change.text('orders');
  change.text('7');
  change.u8(1);
  const said = new ByteWriter();
  for (const [kind, body] of [
    [37, progress.finish()],
    [5, change.finish()],
  ] as const) {
    said.u8(kind);
    said.lenbytes(body);
  }
  const node = await nodeOf(4, said.finish());
  const conn = await connect({ host: '127.0.0.1', port: node.port });
  const arrived = [];
  for await (const item of conn.changes({ table: 'orders', condition: 'open' }))
    arrived.push(item);
  assert.deepEqual(arrived[0], { kind: 'progress', sequence: 41n, cursor: '1.1:d=12' });
  assert.equal(arrived.length, 2);
  const second = arrived[1];
  assert.ok(second !== undefined && !('kind' in second) && second.fate === 'removed');
});
