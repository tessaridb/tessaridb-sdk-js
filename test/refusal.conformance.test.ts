import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readRefusal } from '../src/wire/message.ts';
import { hexToBytes, readCorpus } from './corpus.ts';

interface Vector {
  readonly name: string;
  readonly body_hex: string;
  readonly decoded: { readonly class: string | null; readonly message: string };
}

function isVector(item: unknown): item is Vector {
  if (item === null || typeof item !== 'object') return false;
  const v = item as Record<string, unknown>;
  const decoded = v['decoded'] as Record<string, unknown> | undefined;
  return (
    typeof v['name'] === 'string' &&
    typeof v['body_hex'] === 'string' &&
    decoded !== undefined &&
    typeof decoded['message'] === 'string' &&
    (decoded['class'] === null || typeof decoded['class'] === 'string')
  );
}

test('every refusal vector reads to its class and its words (§3.6)', () => {
  const vectors = readCorpus('frames-v1.json')['refusal'];
  assert.ok(
    Array.isArray(vectors) && vectors.length > 0,
    'the corpus carries refusal vectors',
  );
  for (const vector of vectors) {
    assert.ok(isVector(vector), `malformed vector: ${JSON.stringify(vector)}`);
    const read = readRefusal(hexToBytes(vector.body_hex));
    assert.equal(read.refusalClass ?? null, vector.decoded.class, vector.name);
    assert.equal(read.message, vector.decoded.message, vector.name);
  }
});
