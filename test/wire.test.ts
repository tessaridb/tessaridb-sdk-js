import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ByteWriter } from '../src/codec/bytes.ts';
import { readAnswer } from '../src/wire/outcome.ts';

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
