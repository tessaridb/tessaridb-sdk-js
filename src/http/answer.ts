/**
 * Reading `POST /script`'s answer (§5.6).
 *
 * The six outcome kinds are the same six the wire carries, and the values inside
 * them are not: this surface spells a value in JSON, which has six types against
 * the store's seventeen (§5.7). So the records and the `value` outcome arrive as
 * JSON, and turning one into a typed value is the caller's separate act, with the
 * shape the catalog declares — `interpret` is where that happens.
 *
 * Three distinctions on this transport are carried by **whether a key is there**
 * rather than by what it holds, and each is a place where the obvious model is
 * wrong:
 *
 *   - `{"kind":"value"}` is the language's `none`; `{"kind":"value","value":null}`
 *     is a stored `null`. JSON has one word for both.
 *   - `plan` with no `exact` key is a node that predates the field — not an exact
 *     read. Three states, and the third must not be read as the first.
 *   - `suggestion` absent means no term dictionary was consulted. Present and
 *     empty means one was, and found nothing to fix. This is the one key here
 *     whose absence is not the dull value, which is why the empty object is
 *     written out rather than omitted.
 */

import { ProtocolError } from '../error.ts';
import type { AccessPath, Exactness, Note, Suggestion } from '../wire/outcome.ts';
import type { JsonValue } from './json.ts';

const PATHS = new Set<string>([
  'record',
  'index',
  'ordered',
  'scan',
  'approximate',
  'graph',
  'join',
  'materialised',
  'span',
]);

/**
 * How the read reached its records.
 *
 * `access` is the word the node actually wrote and is kept verbatim, because it
 * and `source` and `shape` sit in one object and only `access` is a closed set —
 * a node that grows a tenth path should not be unreadable. Every other key is
 * absent when the read had no answer for it, rather than present holding null.
 */
export interface Plan {
  readonly access: string;
  readonly exactness: Exactness;
  readonly source?: string;
  readonly table?: string;
  readonly index?: string;
  readonly shape?: string;
  readonly columns?: number;
  readonly cells?: number;
  readonly atMost?: number;
}

/** A record as this surface pairs it: the identity, and the record itself. */
export interface Row {
  readonly id: string;
  readonly value: JsonValue;
}

export type HttpOutcome =
  | { readonly kind: 'done' }
  /** `value` is absent for the language's `none`. Test with `'value' in outcome`. */
  | { readonly kind: 'value'; readonly value?: JsonValue }
  | {
      readonly kind: 'records';
      readonly path: AccessPath;
      readonly plan: Plan;
      readonly records: Row[];
      readonly notes: Note[];
      readonly only: boolean;
      readonly suggestion: Suggestion;
    }
  | { readonly kind: 'keys'; readonly keys: string[] }
  | { readonly kind: 'removed'; readonly count: number }
  | { readonly kind: 'unknown' };

function object(
  json: JsonValue | undefined,
  what: string,
): { [key: string]: JsonValue } {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new ProtocolError(`${what} must be a JSON object`);
  }
  return json;
}

function word(json: JsonValue | undefined, what: string): string | undefined {
  if (json === undefined) return undefined;
  if (typeof json !== 'string') throw new ProtocolError(`${what} must be a string`);
  return json;
}

function whole(json: JsonValue | undefined, what: string): number | undefined {
  if (json === undefined) return undefined;
  if (typeof json === 'bigint') return Number(json);
  if (typeof json !== 'number' || !Number.isInteger(json)) {
    throw new ProtocolError(`${what} must be a whole number`);
  }
  return json;
}

function readPlan(json: JsonValue | undefined): Plan {
  const body = object(json, 'a plan');
  const access = word(body['access'], 'a plan`s access');
  if (access === undefined) throw new ProtocolError('a plan must carry `access`');

  const exact = body['exact'];
  let exactness: Exactness;
  if (exact === undefined) {
    // The third state: a node that predates the field said nothing. Reading it
    // as `exact` would turn silence into a claim.
    exactness = { kind: 'unstated' };
  } else if (exact === true) {
    exactness = { kind: 'exact' };
  } else if (exact === false) {
    exactness = {
      kind: 'inexact',
      reason: word(body['inexact'], 'a plan`s inexact') ?? '',
    };
  } else {
    throw new ProtocolError('a plan`s `exact` must be a boolean');
  }

  const plan: { -readonly [K in keyof Plan]: Plan[K] } = { access, exactness };
  const source = word(body['source'], 'a plan`s source');
  if (source !== undefined) plan.source = source;
  const table = word(body['table'], 'a plan`s table');
  if (table !== undefined) plan.table = table;
  const index = word(body['index'], 'a plan`s index');
  if (index !== undefined) plan.index = index;
  const shape = word(body['shape'], 'a plan`s shape');
  if (shape !== undefined) plan.shape = shape;
  const columns = whole(body['columns'], 'a plan`s columns');
  if (columns !== undefined) plan.columns = columns;
  const cells = whole(body['cells'], 'a plan`s cells');
  if (cells !== undefined) plan.cells = cells;
  const atMost = whole(body['at_most'], 'a plan`s at_most');
  if (atMost !== undefined) plan.atMost = atMost;
  return plan;
}

function readNotes(json: JsonValue | undefined): Note[] {
  if (json === undefined) return [];
  if (!Array.isArray(json)) throw new ProtocolError('`notes` must be an array');
  return json.map((one) => {
    const note = object(one, 'a note');
    // An unrecognised kind is carried through rather than dropped: a note this
    // build does not know is still the store reporting a qualified answer.
    return {
      kind: word(note['kind'], 'a note`s kind') ?? '',
      message: word(note['message'], 'a note`s message') ?? '',
    };
  });
}

function readSuggestion(json: JsonValue | undefined): Suggestion {
  if (json === undefined) return { kind: 'not-consulted' };
  const body = object(json, 'a suggestion');
  const corrections = body['corrections'];
  if (!Array.isArray(corrections))
    throw new ProtocolError('a suggestion must carry `corrections`');
  if (corrections.length === 0) return { kind: 'complete' };
  return {
    kind: 'corrections',
    items: corrections.map((one) => {
      const pair = object(one, 'a correction');
      return {
        typed: word(pair['typed'], 'a correction`s typed') ?? '',
        instead: word(pair['instead'], 'a correction`s instead') ?? '',
      };
    }),
  };
}

function readRows(json: JsonValue | undefined): Row[] {
  if (!Array.isArray(json)) throw new ProtocolError('`records` must be an array');
  return json.map((one) => {
    const pair = object(one, 'a record');
    const id = word(pair['id'], 'a record`s id');
    if (id === undefined) throw new ProtocolError('a record must carry `id`');
    // An element is a PAIR. A client that types this array as the records reads
    // every field one level too high.
    return { id, value: pair['value'] ?? null };
  });
}

export function readOutcome(json: JsonValue): HttpOutcome {
  const body = object(json, 'an outcome');
  const kind = word(body['kind'], 'an outcome`s kind');

  switch (kind) {
    case 'done':
      return { kind: 'done' };
    case 'value':
      // The key's presence is the distinction, so it is only set when present.
      return 'value' in body
        ? { kind: 'value', value: body['value'] }
        : { kind: 'value' };
    case 'removed': {
      const count = whole(body['count'], 'a removed count');
      if (count === undefined)
        throw new ProtocolError('a removed outcome must carry `count`');
      return { kind: 'removed', count };
    }
    case 'keys': {
      const keys = body['keys'];
      if (!Array.isArray(keys)) throw new ProtocolError('`keys` must be an array');
      // The id half alone — the statement named the table, so the answer does
      // not repeat it, and there is no colon to split on.
      return { kind: 'keys', keys: keys.map((k) => word(k, 'a key') ?? '') };
    }
    case 'records': {
      const path = word(body['path'], 'a records path') ?? '';
      return {
        kind: 'records',
        // The node's own word is kept in `plan.access`; an unrecognised one
        // reads as `scan` here so a caller may still switch exhaustively, which
        // is the rule §3.9 states for the same field on the wire.
        path: (PATHS.has(path) ? path : 'scan') as AccessPath,
        plan: readPlan(body['plan']),
        records: readRows(body['records']),
        notes: readNotes(body['notes']),
        only: body['only'] === true,
        suggestion: readSuggestion(body['suggestion']),
      };
    }
    case 'unknown':
      // An outcome this build cannot read — which points at upgrading, not at
      // shrugging. It is surfaced rather than dropped.
      return { kind: 'unknown' };
    default:
      throw new ProtocolError(`unknown outcome kind ${JSON.stringify(kind)}`);
  }
}

/**
 * Reads the whole answer body.
 *
 * A script is all-or-nothing on this route: if any statement fails the response
 * is a refusal carrying that statement's error and the outcomes of the ones that
 * already succeeded are not reported. That describes the RESPONSE and not the
 * store — the statements that ran have taken effect and are durable — which is
 * why this client neither reports a failed script as "nothing happened" nor
 * retries one.
 */
export function readAnswerBody(json: JsonValue): HttpOutcome[] {
  const body = object(json, 'an answer');
  const results = body['results'];
  if (!Array.isArray(results))
    throw new ProtocolError('an answer must carry `results`');
  return results.map(readOutcome);
}
