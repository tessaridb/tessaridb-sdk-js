import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { and, BuilderError, compare, or, QueueArgumentError } from '../src/index.ts';
import type { Filter, Operator, Value } from '../src/index.ts';
import { QueueStatements } from '../src/queue.ts';
import { readCorpus } from './corpus.ts';

/**
 * The shared queue corpus, run against the class the worker builds every
 * statement through: byte-identical text, identical parameter names, and every
 * bad name or count refused before anything is sent.
 */

type Encoded = { string: string } | { integer: string };
type Node =
  | { compare: { field: string; op: Operator; value: Encoded } }
  | { and: [Node, Node] }
  | { or: [Node, Node] };

interface Fields {
  namespace: string;
  database: string;
  queue: string;
  worker?: string;
  count?: number;
  where?: Node;
  id?: string;
  after_ms?: number;
}

interface Case {
  name: string;
  build: Record<string, Fields>;
  script?: string;
  parameters?: Record<string, Encoded>;
  refused?: { reason: string; what: string; name: string };
}

function value(encoded: Encoded): Value {
  return 'string' in encoded
    ? { kind: 'string', value: encoded.string }
    : { kind: 'integer', value: BigInt(encoded.integer) };
}

function encode(held: Value): Encoded {
  if (held.kind === 'string') return { string: held.value };
  if (held.kind === 'integer') return { integer: held.value.toString() };
  throw new Error(`a value this test does not encode: ${held.kind}`);
}

function where(node: Node): Filter {
  if ('compare' in node) {
    return compare(node.compare.field, node.compare.op, value(node.compare.value));
  }
  if ('and' in node) return and(where(node.and[0]), where(node.and[1]));
  return or(where(node.or[0]), where(node.or[1]));
}

function rendered(kind: string, fields: Fields): [string, Record<string, Encoded>] {
  const statements = new QueueStatements({
    ...fields,
    worker: fields.worker ?? 'worker',
  });
  let script: string;
  let parameters = new Map<string, Value>();
  switch (kind) {
    case 'claim':
      [script, parameters] = statements.claim(
        fields.count ?? 0,
        fields.where ? where(fields.where) : undefined,
      );
      break;
    case 'done':
      script = statements.done(fields.id ?? '');
      break;
    case 'release':
      script = statements.release(fields.id ?? '', fields.after_ms);
      break;
    default:
      throw new Error(`a build kind this test does not know: ${kind}`);
  }
  const bound: Record<string, Encoded> = {};
  for (const [name, held] of parameters) bound[name] = encode(held);
  return [script, bound];
}

function refusal(error: unknown): { reason: string; what: string; name: string } {
  if (error instanceof QueueArgumentError) {
    return { reason: error.reason, what: error.position, name: error.offending };
  }
  if (error instanceof BuilderError) {
    return {
      reason: error.reason,
      what: error.position ?? '',
      name: error.offending ?? '',
    };
  }
  throw error;
}

test('every queue statement renders as the corpus says', () => {
  const cases = readCorpus('queue-v1.json')['cases'] as Case[];
  assert.ok(cases.length > 0, 'a corpus with no cases checks nothing');
  for (const each of cases) {
    const [kind, fields] =
      Object.entries(each.build)[0] ?? assert.fail(`${each.name}: no build`);
    if (each.refused) {
      assert.throws(
        () => rendered(kind, fields),
        (error: unknown) => {
          assert.deepEqual(refusal(error), each.refused, each.name);
          return true;
        },
        each.name,
      );
    } else {
      const [script, parameters] = rendered(kind, fields);
      assert.equal(script, each.script, each.name);
      assert.deepEqual(parameters, each.parameters, each.name);
    }
  }
});
