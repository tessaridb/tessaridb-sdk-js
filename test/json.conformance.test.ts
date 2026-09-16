import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { interpret, parseJson } from '../src/index.ts';
import type { Names, Shape, Value } from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { corpusPath, valueOf } from './corpus.ts';

/**
 * The JSON corpus of §5.6 and §5.7, read back with the field's kind supplied.
 *
 * §5.7 is explicit that the type of a value is not recoverable from the JSON
 * alone, and it says what a caller does about it: read the kind from the field's
 * declaration in the catalog. This suite does exactly that — the shape comes from
 * the case's stated value, which is what a catalog would have told a caller — and
 * then asserts the read produces that value.
 *
 * One case cannot be read back even so, and it is asserted as unrecoverable
 * rather than skipped. A suite that quietly dropped it would report a round trip
 * this surface does not have.
 */

const CASES_WHEN_WRITTEN = 59;

/**
 * A float `-0.0` is written `0` — §5.7.1 writes a float positionally with no
 * trailing `.0`, so it is the same six bytes an integer `0` would produce. No
 * reader can recover the sign of a zero from that, and the corpus carries the
 * case precisely so a client has to say so.
 */
const UNRECOVERABLE = new Map([
  [
    'float-negative-zero',
    'a float -0.0 is written `0`, as +0.0 and the integer 0 both are',
  ],
]);

type Json = Record<string, unknown>;

/** The shape a catalog would have given, derived from the case's stated value. */
function shapeOf(notation: Json): Shape {
  const [key, body] = Object.entries(notation)[0] as [string, unknown];
  switch (key) {
    case 'float_bits':
      return { kind: 'float' };
    case 'record': {
      const id = Object.keys((body as Json)['id'] as Json)[0];
      return {
        kind: 'record',
        id: id === 'int' ? 'integer' : (id as 'text' | 'uuid' | 'bytes'),
      };
    }
    case 'array':
    case 'set':
      return { kind: key, of: (body as Json[]).map(shapeOf) };
    case 'object': {
      const fields: Record<string, Shape> = {};
      for (const [field, value] of Object.entries(body as Json)) {
        fields[field] = shapeOf(value as Json);
      }
      return { kind: 'object', fields };
    }
    case 'range': {
      const ends = body as Json;
      for (const end of [ends['start'], ends['end']]) {
        const [bound, value] = Object.entries(end as Json)[0] as [string, unknown];
        if (bound !== 'unbounded') return { kind: 'range', of: shapeOf(value as Json) };
      }
      // Both ends unbounded: no endpoint is read, so any shape serves.
      return { kind: 'range', of: { kind: 'null' } };
    }
    default:
      return { kind: key } as Shape;
  }
}

function names(corpus: Record<string, unknown>): Names {
  const byName = new Map<string, number>();
  for (const [id, name] of Object.entries(corpus['names'] as Record<string, string>)) {
    byName.set(name, Number(id));
  }
  return byName;
}

test('every JSON value reads back to the value the store held', () => {
  // Read with this client's own reader rather than `JSON.parse`: the corpus
  // carries an i64 at the top of its range, and parsing it the ordinary way
  // loses it before the code under test ever sees it.
  const corpus = parseJson(readFileSync(corpusPath('json-v1.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(corpus['protocol_major'], 1, 'this client implements a different major');

  const cases = corpus['cases'] as {
    name: string;
    value: Json;
    json?: unknown;
    omitted?: boolean;
  }[];
  assert.ok(
    cases.length >= CASES_WHEN_WRITTEN,
    `the corpus shrank to ${cases.length} cases — a suite cannot get stronger by losing vectors`,
  );

  const table = names(corpus);
  let recovered = 0;
  const unrecoverable: string[] = [];

  for (const c of cases) {
    const expected = valueOf(c.value as never);

    if (c.omitted) {
      // The encoding IS the absence of the key, which is what keeps `none` and
      // `null` apart on a surface that has one word for both.
      assert.deepStrictEqual(
        interpret(undefined, { kind: 'null' }, table),
        { kind: 'none' },
        `${c.name}: an absent key is none, never null`,
      );
      recovered += 1;
      continue;
    }

    const read = interpret(c.json as never, shapeOf(c.value), table);

    const reason = UNRECOVERABLE.get(c.name);
    if (reason) {
      assert.notDeepStrictEqual(
        read,
        expected,
        `${c.name}: claimed unrecoverable but round-tripped`,
      );
      unrecoverable.push(`${c.name} — ${reason}`);
      continue;
    }

    assert.deepStrictEqual(read, expected, `${c.name}: read back`);
    recovered += 1;
  }

  console.log(
    `  recovered ${recovered} of ${cases.length}; unrecoverable ${unrecoverable.length}`,
  );
  for (const one of unrecoverable) console.log(`    ${one}`);
  assert.equal(
    recovered + unrecoverable.length,
    cases.length,
    'every case is accounted for',
  );
});

test('an integer beyond a double survives the reader', () => {
  // JSON.parse alone answers 9223372036854775808 here, and reports nothing.
  const json = parseJson('{"id":9223372036854775807}') as { id: bigint };
  assert.equal(json.id, 9223372036854775807n);
  assert.deepStrictEqual(interpret(json.id, { kind: 'integer' }), {
    kind: 'integer',
    value: 9223372036854775807n,
  });
});

test('a quoted non-finite is a float and not a string', () => {
  const float = (json: unknown): Value => interpret(json as never, { kind: 'float' });
  assert.deepStrictEqual(float('inf'), {
    kind: 'float',
    value: Number.POSITIVE_INFINITY,
  });
  assert.deepStrictEqual(float('-inf'), {
    kind: 'float',
    value: Number.NEGATIVE_INFINITY,
  });
  assert.ok(Number.isNaN((float('NaN') as { value: number }).value));
});
