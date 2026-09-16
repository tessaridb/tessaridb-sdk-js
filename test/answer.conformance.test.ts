import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseJson, readOutcome } from '../src/index.ts';
import type { HttpOutcome, JsonValue } from '../src/index.ts';
import { corpusPath } from './corpus.ts';

/**
 * The twenty outcome shapes of §5.6.
 *
 * The corpus states each outcome in the wire's own typed notation beside the JSON
 * a node writes for it. This client's HTTP outcome deliberately does not carry
 * typed values — §5.7's spelling cannot supply them — so the assertions here are
 * about everything else: the kind, the counts, the identities, the plan, and the
 * three distinctions this transport carries by whether a key is present.
 *
 * Those three are the whole reason the file is long. Each has an obvious wrong
 * model that passes a naive test.
 */

const OUTCOMES_WHEN_WRITTEN = 20;

type Json = Record<string, unknown>;

/** The single tag of a corpus notation object. */
function tagged(notation: Json): [string, unknown] {
  const entries = Object.entries(notation);
  assert.equal(entries.length, 1, 'a corpus notation object carries one tag');
  return entries[0] as [string, unknown];
}

/** `{"record":{"table":3,"id":{"int":"1"}}}` → `"1"`, the id half alone. */
function idHalf(notation: Json): string {
  const [, body] = tagged(notation);
  const [, id] = tagged((body as Json)['id'] as Json);
  return String(id);
}

interface Case {
  name: string;
  outcome: Json;
  json: JsonValue;
}

function outcomes(): Case[] {
  const corpus = parseJson(readFileSync(corpusPath('json-v1.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const list = corpus['outcomes'] as unknown as Case[];
  assert.ok(
    list.length >= OUTCOMES_WHEN_WRITTEN,
    `the corpus shrank to ${list.length} outcomes — a suite cannot get stronger by losing them`,
  );
  return list;
}

test('every outcome shape reads to the outcome the node reported', () => {
  let checked = 0;

  for (const c of outcomes()) {
    const read = readOutcome(c.json);
    const [kind, body] = tagged(c.outcome);
    assert.equal(read.kind, kind, `${c.name}: kind`);

    switch (kind) {
      case 'done':
      case 'unknown':
        break;

      case 'value': {
        // The key's presence is the distinction, and nothing else carries it.
        const held = tagged(body as Json)[0];
        const present = 'value' in read;
        assert.equal(present, held !== 'none', `${c.name}: none has no value key`);
        if (present) {
          assert.deepStrictEqual(
            (read as { value: JsonValue }).value,
            (c.json as Json)['value'],
            `${c.name}: the value itself`,
          );
        }
        break;
      }

      case 'removed':
        assert.equal(
          (read as { count: number }).count,
          Number(body),
          `${c.name}: count`,
        );
        break;

      case 'keys': {
        const expected = (body as Json[]).map(idHalf);
        assert.deepStrictEqual(
          (read as { keys: string[] }).keys,
          expected,
          `${c.name}: keys`,
        );
        break;
      }

      case 'records': {
        const stated = body as Json;
        const records = read as Extract<HttpOutcome, { kind: 'records' }>;
        const plan = stated['plan'] as Json;

        assert.equal(records.plan.access, plan['access'], `${c.name}: plan access`);
        assert.equal(
          records.path,
          records.plan.access,
          `${c.name}: path equals plan access`,
        );

        // Three states, and the third is the one a client gets wrong: a plan
        // with no `exact` key is a node that predates the field, not an exact
        // read.
        if (!('exact' in plan)) {
          assert.deepStrictEqual(
            records.plan.exactness,
            { kind: 'unstated' },
            `${c.name}: unstated`,
          );
        } else if (plan['exact'] === true) {
          assert.deepStrictEqual(
            records.plan.exactness,
            { kind: 'exact' },
            `${c.name}: exact`,
          );
        } else {
          assert.deepStrictEqual(
            records.plan.exactness,
            { kind: 'inexact', reason: plan['inexact'] },
            `${c.name}: inexact carries the node's own reason`,
          );
        }

        for (const [key, target] of [
          ['table', 'table'],
          ['index', 'index'],
          ['shape', 'shape'],
          ['source', 'source'],
          ['cells', 'cells'],
          ['columns', 'columns'],
          ['at_most', 'atMost'],
        ] as const) {
          assert.equal(
            (records.plan as unknown as Json)[target],
            plan[key],
            `${c.name}: plan ${key} — absent when the read had no answer for it`,
          );
        }

        const rows = (stated['rows'] as Json[]) ?? [];
        assert.equal(records.records.length, rows.length, `${c.name}: record count`);
        rows.forEach((row, i) => {
          assert.equal(
            records.records[i]?.id,
            idHalf(row['id'] as Json),
            `${c.name}: record ${i} identity`,
          );
        });

        assert.deepStrictEqual(
          records.notes,
          stated['notes'] ?? [],
          `${c.name}: notes`,
        );
        assert.equal(records.only, stated['only'] === true, `${c.name}: only`);

        // Absent is not the dull value here: it means no term dictionary was
        // consulted, which is different from one having found nothing to fix.
        const suggestion = stated['suggestion'] as unknown[] | undefined;
        if (suggestion === undefined) {
          assert.deepStrictEqual(
            records.suggestion,
            { kind: 'not-consulted' },
            `${c.name}: not consulted`,
          );
        } else if (suggestion.length === 0) {
          assert.deepStrictEqual(
            records.suggestion,
            { kind: 'complete' },
            `${c.name}: complete`,
          );
        } else {
          assert.deepStrictEqual(
            records.suggestion,
            { kind: 'corrections', items: suggestion },
            `${c.name}: corrections`,
          );
        }
        break;
      }

      default:
        assert.fail(
          `${c.name}: the corpus carries an outcome this test does not translate`,
        );
    }
    checked += 1;
  }

  console.log(`  ${checked} outcome shapes read exactly`);
});

test('a records outcome with nothing to report is not an exact read by default', () => {
  // The single most tempting wrong model on this transport.
  const read = readOutcome(
    parseJson('{"kind":"records","path":"scan","plan":{"access":"scan"},"records":[]}'),
  ) as Extract<HttpOutcome, { kind: 'records' }>;

  assert.deepStrictEqual(read.plan.exactness, { kind: 'unstated' });
  assert.deepStrictEqual(read.suggestion, { kind: 'not-consulted' });
  assert.equal(read.only, false);
  assert.deepStrictEqual(read.notes, []);
});

test('an unrecognised access path reads as scan and keeps the node’s own word', () => {
  const read = readOutcome(
    parseJson(
      '{"kind":"records","path":"teleport","plan":{"access":"teleport","exact":true},"records":[]}',
    ),
  ) as Extract<HttpOutcome, { kind: 'records' }>;

  assert.equal(read.path, 'scan', 'a caller may still switch exhaustively');
  assert.equal(
    read.plan.access,
    'teleport',
    'and nothing the node said was thrown away',
  );
});
