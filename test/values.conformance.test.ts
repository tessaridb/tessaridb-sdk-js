import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decodeValue, encodeValue } from '../src/index.ts';
import { bytesToHex, hexToBytes, readCorpus, valueOf } from './corpus.ts';

/**
 * The shared value corpus, run against this client in both directions.
 *
 * Decoding alone does not check a codec. A codec that is wrong in the same way on
 * both sides round-trips perfectly — mutating both halves of the `i64` inversion
 * is invisible to any test this repository could write about itself. The corpus
 * is the external anchor, and both directions are run against it.
 */

const CASES_WHEN_WRITTEN = 54;

test('every corpus vector encodes and decodes exactly', () => {
  const corpus = readCorpus('values-v1.json');

  assert.equal(
    corpus['protocol_major'],
    1,
    'this client implements a different major from the corpus',
  );

  const cases = corpus['cases'] as {
    name: string;
    value: Record<string, unknown>;
    bytes: string;
  }[];
  assert.ok(Array.isArray(cases), 'the corpus has cases');
  assert.ok(
    cases.length >= CASES_WHEN_WRITTEN,
    `the corpus shrank to ${cases.length} cases — a suite cannot get stronger by losing vectors`,
  );

  for (const { name, value: notation, bytes: expected } of cases) {
    const value = valueOf(notation);

    // Forwards: this client must produce exactly the corpus's bytes.
    const encoded = bytesToHex(encodeValue(value));
    assert.equal(
      encoded,
      expected,
      `case ${name}: this client encoded ${encoded} but the corpus says ${expected}`,
    );

    // Backwards: the corpus's bytes must decode to exactly the value — not to
    // something that re-encodes to the same bytes, which a symmetric bug would.
    const decoded = decodeValue(hexToBytes(expected));
    assert.deepStrictEqual(decoded, value, `case ${name}: decoded to the wrong value`);
  }

  console.log(`conformance: ${cases.length} vectors, both directions`);
});

test('a value payload with trailing bytes is refused', () => {
  const good = encodeValue({ kind: 'bool', value: true });
  const trailing = new Uint8Array([...good, 0x00]);
  assert.throws(() => decodeValue(trailing), /trailing/);
});

test('an unknown type tag is an error rather than a guess', () => {
  assert.throws(() => decodeValue(new Uint8Array([0x7f])), /unknown value tag/);
});

test('nanoseconds outside the sub-second range are an error, not a wrap', () => {
  assert.throws(
    () => encodeValue({ kind: 'duration', seconds: 0n, nanos: 1_000_000_000 }),
    /outside/,
  );
});
