import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BuilderError, compare, select } from '../src/index.ts';
import type { Value } from '../src/index.ts';
import { readCorpus, valueOf } from './corpus.ts';
import { render } from './build.ts';
import type { Json } from './build.ts';

/**
 * The shared query corpus, run against this builder.
 *
 * The rendering contract states what a builder must render; this corpus states
 * the same thing case by case, executably. Together they make every language's
 * builder agree with every other — which is the whole point, because no client
 * may link the node's parser, so each language would otherwise arrive at its own
 * plausible rendering and the divergence would surface as a user reporting that
 * the same query behaves differently depending on which client wrote it.
 *
 * Acceptance is byte-identical text and identical parameter numbering. A
 * rendering that merely parses is not a pass.
 */

const CASES_WHEN_WRITTEN = 30;

interface Case {
  name: string;
  build: Json;
  script?: string;
  parameters?: Record<string, Json>;
  refused?: { reason: string; what?: string; name?: string };
}

function cases(): Case[] {
  const corpus = readCorpus('queries-v1.json');
  assert.equal(
    corpus['contract_major'],
    1,
    'this builder implements a different contract major from the corpus',
  );
  const list = corpus['cases'] as Case[];
  assert.ok(Array.isArray(list), 'the corpus has cases');
  assert.ok(
    list.length >= CASES_WHEN_WRITTEN,
    `the corpus shrank to ${list.length} cases — a suite cannot get stronger by losing cases`,
  );
  return list;
}

test('every corpus case renders to exactly the stated script and parameters', () => {
  let rendered = 0;

  for (const c of cases()) {
    if (c.refused) continue;
    rendered += 1;

    const result = render(c.build);
    assert.equal(result.script, c.script, `${c.name}: rendered text`);

    const expected = new Map<string, Value>(
      Object.entries(c.parameters ?? {}).map(([reference, value]) => [
        reference,
        valueOf(value as never),
      ]),
    );
    assert.deepStrictEqual(result.parameters, expected, `${c.name}: parameters`);
  }

  assert.ok(rendered > 0, 'the corpus carried no renderable case');
  console.log(`  rendered ${rendered} cases byte-identically`);
});

test('every corpus refusal is refused, with the stated reason, and is not rendered', () => {
  let refused = 0;

  for (const c of cases()) {
    if (!c.refused) continue;
    refused += 1;

    // A refusal must arrive as a refusal, not as a rendering the node declines
    // later — which is why this asserts the throw rather than the text.
    assert.throws(
      () => render(c.build),
      (error: unknown) => {
        assert.ok(
          error instanceof BuilderError,
          `${c.name}: refused as a builder refusal`,
        );
        assert.equal(error.reason, c.refused!.reason, `${c.name}: reason`);
        if (c.refused!.what !== undefined) {
          assert.equal(error.position, c.refused!.what, `${c.name}: which position`);
        }
        if (c.refused!.name !== undefined) {
          assert.equal(
            error.offending,
            c.refused!.name,
            `${c.name}: the offending string`,
          );
        }
        return true;
      },
      `${c.name}: must be refused`,
    );
  }

  assert.ok(refused > 0, 'the corpus carried no refusal case');
  console.log(`  refused ${refused} cases with the stated reason`);
});

test('a builder never lets a value reach the statement text', () => {
  // The contract's one guarantee (§2), asserted directly rather than inferred
  // from the corpus passing: a value that spells a statement stays a parameter.
  const hostile = "'; DROP COLLECTION memories; --";
  const { script, parameters } = select('memories')
    .where(compare('body', 'eq', { kind: 'string', value: hostile }))
    .render();

  assert.equal(script, 'SELECT * FROM memories WHERE body = $p0;');
  assert.ok(!script.includes('DROP'), 'the value did not reach the text');
  assert.deepStrictEqual(parameters.get('p0'), { kind: 'string', value: hostile });
});

test('a second WHERE replaces the first rather than combining with it', () => {
  const { script } = select('memories')
    .where(compare('a', 'eq', { kind: 'integer', value: 1n }))
    .where(compare('b', 'eq', { kind: 'integer', value: 2n }))
    .render();

  assert.equal(script, 'SELECT * FROM memories WHERE b = $p0;');
});
