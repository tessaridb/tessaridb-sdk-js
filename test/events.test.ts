import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NotAnEventError } from '../src/index.ts';
import type { Value } from '../src/index.ts';
import { batch, literal } from '../src/http/events.ts';

/**
 * How an event's values are spelled for `POST /series` (§5.9). Offline: the node
 * is the oracle for these spellings and `http.node.test.ts` asks it; this pins
 * each one so a change to the renderer is seen here first.
 */
test('each kind an event carries has its spelling', () => {
  const cases: [Value, string][] = [
    [{ kind: 'null' }, 'NULL'],
    [{ kind: 'bool', value: true }, 'true'],
    [{ kind: 'integer', value: -12n }, '-12'],
    [{ kind: 'float', value: 1 }, '1.0'],
    [{ kind: 'float', value: 1.5e300 }, '1.5e+300'],
    [{ kind: 'decimal', mantissa: -1234n, scale: 2 }, 'dec -12.34'],
    [{ kind: 'decimal', mantissa: 5n, scale: 3 }, 'dec 0.005'],
    [{ kind: 'string', value: "it's \\ ok" }, "'it\\'s \\\\ ok'"],
    [
      { kind: 'datetime', seconds: 1_790_676_000n, nanos: 123_456_789 },
      "datetime '2026-09-29T10:00:00.123456789Z'",
    ],
    [{ kind: 'datetime', seconds: -1n, nanos: 0 }, "datetime '1969-12-31T23:59:59Z'"],
    [
      {
        kind: 'uuid',
        value: Uint8Array.from(Buffer.from('0190a0b1000070008000000000000001', 'hex')),
      },
      "uuid '0190a0b1-0000-7000-8000-000000000001'",
    ],
    [
      {
        kind: 'object',
        fields: new Map<string, Value>([
          ['odd key', { kind: 'array', items: [{ kind: 'bool', value: false }] }],
          ['gone', { kind: 'none' }],
        ]),
      },
      "{ 'odd key': [false] }",
    ],
  ];
  for (const [value, spelled] of cases) assert.equal(literal(value), spelled);
});

test('a kind an event cannot carry is refused before anything is sent', () => {
  const refused: Value[] = [
    { kind: 'float', value: Number.NaN },
    { kind: 'bytes', value: new Uint8Array([1]) },
    { kind: 'array', items: [{ kind: 'none' }] },
  ];
  for (const value of refused) assert.throws(() => literal(value), NotAnEventError);
  assert.throws(() => batch([{ kind: 'bool', value: true }]), NotAnEventError);
});
