import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConsumerNameError } from '../src/index.ts';
import type { Value } from '../src/index.ts';
import { ConsumerStatements } from '../src/consumer.ts';
import { readCorpus } from './corpus.ts';

/**
 * The shared consumer corpus, run against the class the consumer builds every
 * statement through.
 *
 * Each client's live consumer test proves only that its own node accepts what
 * it sends. This corpus, rendered by a second implementation of
 * `spec/consumer-v1.md`, is what makes the five clients agree with one another:
 * byte-identical text, identical parameter names, and every bad name refused
 * before anything is sent.
 */

interface Fields {
  namespace: string;
  database: string;
  topic: string;
  group: string;
  limit?: number;
  positions?: number[];
  delay_ms?: number;
}

interface Case {
  name: string;
  build: Record<string, Fields>;
  script?: string;
  parameters?: Record<string, { integer: string }>;
  refused?: { reason: string; what: string; name: string };
}

function rendered(
  kind: string,
  fields: Fields,
  statements: ConsumerStatements,
): [string, Map<string, Value>] {
  const positions = (fields.positions ?? []).map(BigInt);
  switch (kind) {
    case 'read':
      return [statements.read(fields.limit ?? 0), new Map()];
    case 'ack':
      return statements.ack(positions);
    case 'nack':
      return statements.nack(positions, fields.delay_ms);
    default:
      throw new Error(`a build kind this test does not know: ${kind}`);
  }
}

function bound(parameters: Map<string, Value>): Record<string, { integer: string }> {
  const out: Record<string, { integer: string }> = {};
  for (const [name, value] of parameters) {
    assert.equal(value.kind, 'integer', `${name} is bound as an integer`);
    if (value.kind === 'integer') {
      out[name] = { integer: value.value.toString() };
    }
  }
  return out;
}

test('every consumer statement renders as the corpus says', () => {
  const cases = readCorpus('consumer-v1.json')['cases'] as Case[];
  assert.ok(cases.length > 0, 'a corpus with no cases checks nothing');
  for (const each of cases) {
    const [kind, fields] =
      Object.entries(each.build)[0] ?? assert.fail(`${each.name}: no build`);
    if (each.refused) {
      assert.throws(
        () => new ConsumerStatements(fields),
        (error: unknown) => {
          assert.ok(error instanceof ConsumerNameError, each.name);
          assert.deepEqual(
            { reason: 'not-a-name', what: error.position, name: error.offending },
            each.refused,
            each.name,
          );
          return true;
        },
        each.name,
      );
    } else {
      const [script, parameters] = rendered(
        kind,
        fields,
        new ConsumerStatements(fields),
      );
      assert.equal(script, each.script, each.name);
      assert.deepEqual(bound(parameters), each.parameters, each.name);
    }
  }
});
