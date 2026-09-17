/**
 * Translates the query corpus's `build` notation into calls on this builder.
 *
 * It lives beside the tests rather than inside one because two suites need it:
 * the offline rendering check and the live node run. A second translation written
 * for the second suite would be a second chance to be wrong, in the one place
 * where both suites' agreement is the evidence.
 */

import {
  and,
  compare,
  createInTable,
  createRecord,
  deleteRecord,
  or,
  select,
  updateRecord,
} from '../src/index.ts';
import type { Filter, Operator, Rendered, Value } from '../src/index.ts';
import { valueOf } from './corpus.ts';

export type Json = Record<string, unknown>;

function filterOf(spec: Json): Filter {
  if ('compare' in spec) {
    const c = spec['compare'] as { field: string; op: string; value: Json };
    return compare(c.field, c.op as Operator, valueOf(c.value as never));
  }
  if ('and' in spec) {
    const [left, right] = spec['and'] as Json[];
    return and(filterOf(left!), filterOf(right!));
  }
  if ('or' in spec) {
    const [left, right] = spec['or'] as Json[];
    return or(filterOf(left!), filterOf(right!));
  }
  throw new Error(
    `the corpus carries a filter shape this test does not translate: ${JSON.stringify(spec)}`,
  );
}

function fieldsOf(spec: Json | undefined): Map<string, Value> {
  const set = new Map<string, Value>();
  for (const [field, value] of Object.entries(spec ?? {})) {
    set.set(field, valueOf(value as never));
  }
  return set;
}

export function render(build: Json): Rendered {
  if ('select' in build) {
    const s = build['select'] as Json;
    const statement = select(s['from'] as string);
    for (const item of (s['fields'] as unknown[]) ?? []) {
      if (typeof item === 'string') {
        statement.field(item);
      } else {
        const w = (item as Json)['lines'] as {
          field: string;
          start: number;
          count: number;
        };
        statement.lines(w.field, w.start, w.count);
      }
    }
    if (s['where'] !== undefined) {
      statement.where(filterOf(s['where'] as Json));
    }
    for (const [field, direction] of (s['order'] as [string, string][]) ?? []) {
      statement.orderBy(field, direction as 'asc' | 'desc');
    }
    if (s['start'] !== undefined) {
      statement.start(s['start'] as number);
    }
    if (s['staleness'] !== undefined) {
      statement.staleness(s['staleness'] as string);
    }
    if (s['answered_by'] !== undefined) {
      statement.answeredBy(s['answered_by'] as string);
    }
    if (s['limit'] !== undefined) {
      statement.limit(s['limit'] as number);
    }
    return statement.render();
  }

  if ('create_record' in build) {
    const c = build['create_record'] as Json;
    const statement = createRecord(c['table'] as string, valueOf(c['id'] as never));
    for (const [field, value] of fieldsOf(c['set'] as Json))
      statement.set(field, value);
    return statement.render();
  }

  if ('create_in_table' in build) {
    const c = build['create_in_table'] as Json;
    const statement = createInTable(c['table'] as string);
    for (const [field, value] of fieldsOf(c['set'] as Json))
      statement.set(field, value);
    return statement.render();
  }

  if ('update_record' in build) {
    const u = build['update_record'] as Json;
    const statement = updateRecord(u['table'] as string, valueOf(u['id'] as never));
    for (const [field, value] of fieldsOf(u['set'] as Json))
      statement.set(field, value);
    return statement.render();
  }

  if ('delete_record' in build) {
    const d = build['delete_record'] as Json;
    return deleteRecord(d['table'] as string, valueOf(d['id'] as never)).render();
  }

  throw new Error(
    `the corpus carries a statement this test does not translate: ${JSON.stringify(build)}`,
  );
}
