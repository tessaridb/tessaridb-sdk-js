/**
 * The four statements a builder offers — `SELECT`, `CREATE`, `UPDATE`, `DELETE`
 * over a single collection (§4 of the rendering contract).
 *
 * Anything else is written by the caller as a script and sent as one, which is
 * always available. A builder must not grow a clause the contract has not grown
 * first: a clause one language has and another does not is exactly the divergence
 * the contract exists to prevent.
 */

import type { Value } from '../value.ts';
import { type Filter, renderFilter } from './filter.ts';
import { Binder, BuilderError, count, name, type Rendered } from './grammar.ts';

export type Direction = 'asc' | 'desc';

type Item =
  | { readonly kind: 'field'; readonly field: string }
  | {
      readonly kind: 'lines';
      readonly field: string;
      readonly start: string;
      readonly count: string;
    };

/**
 * Fields of an object or a `SET`, in ascending order of their names (§4.8).
 *
 * Call order is deliberately discarded: two builders given the same fields in
 * different orders must produce the same text and the same parameter numbering,
 * or a corpus could not carry a field set as an unordered object.
 *
 * The contract says UTF-8 byte order, and JavaScript's default comparison is by
 * UTF-16 code unit — a distinction with no difference here, because a name is
 * ASCII by construction and the two orders coincide over ASCII. Do not "fix" this
 * into a byte comparison; the guard in front of it is what makes it correct.
 */
function ordered(fields: Map<string, Value>): [string, Value][] {
  return [...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `{ body: $p1, weight: $p2 }` — note the spaces immediately inside the braces. */
function object(fields: Map<string, Value>, binder: Binder): string {
  const rendered = ordered(fields).map(
    ([field, value]) => `${field}: ${binder.bind(value)}`,
  );
  return `{ ${rendered.join(', ')} }`;
}

export class Select {
  readonly #table: string;
  readonly #items: Item[] = [];
  readonly #order: [string, Direction][] = [];
  #filter: Filter | undefined;
  #start: string | undefined;
  #limit: string | undefined;

  constructor(table: string) {
    this.#table = name('a table', table);
  }

  /** Name a field. Named items render in the order they were named. */
  field(field: string): this {
    this.#items.push({ kind: 'field', field: name('a field', field) });
    return this;
  }

  /**
   * Read `count` lines of a long text field from a zero-based `start`, so a large
   * body does not come back whole. The field arrives under its own name.
   */
  lines(field: string, start: number | bigint, lineCount: number | bigint): this {
    this.#items.push({
      kind: 'lines',
      field: name('a field', field),
      start: count(start),
      count: count(lineCount),
    });
    return this;
  }

  /**
   * Replaces any filter already set rather than combining with it — silently
   * `AND`ing two would make a duplicated call look as though it had worked.
   */
  where(filter: Filter): this {
    this.#filter = filter;
    return this;
  }

  /** The direction is always written out, including the node's default. */
  orderBy(field: string, direction: Direction): this {
    this.#order.push([name('a field', field), direction]);
    return this;
  }

  start(n: number | bigint): this {
    this.#start = count(n);
    return this;
  }

  limit(n: number | bigint): this {
    this.#limit = count(n);
    return this;
  }

  render(): Rendered {
    const binder = new Binder();
    const projection =
      this.#items.length === 0
        ? '*'
        : this.#items
            .map((item) =>
              item.kind === 'field'
                ? item.field
                : `string::lines(${item.field}, ${item.start}, ${item.count}) AS ${item.field}`,
            )
            .join(', ');

    let script = `SELECT ${projection} FROM ${this.#table}`;
    if (this.#filter !== undefined) {
      script += ` WHERE ${renderFilter(this.#filter, binder)}`;
    }
    if (this.#order.length > 0) {
      const orderings = this.#order.map(([field, d]) => `${field} ${d.toUpperCase()}`);
      script += ` ORDER BY ${orderings.join(', ')}`;
    }
    if (this.#start !== undefined) {
      script += ` START ${this.#start}`;
    }
    if (this.#limit !== undefined) {
      script += ` LIMIT ${this.#limit}`;
    }
    return { script: `${script};`, parameters: binder.parameters };
  }
}

/** Fields shared by the statements that carry an object or a `SET`. */
abstract class WithFields {
  protected readonly fields = new Map<string, Value>();

  set(field: string, value: Value): this {
    this.fields.set(name('a field', field), value);
    return this;
  }

  protected demandFields(statement: string): void {
    if (this.fields.size === 0) {
      throw BuilderError.incomplete(
        `a ${statement} with no fields cannot be rendered — it would be an empty object, which means something else`,
      );
    }
  }
}

/**
 * `CREATE <table>:$p0 = { … }` — the caller supplies the identity.
 *
 * The identity travels as a parameter, never as text, so an identity that happens
 * to spell a statement is a record with an unusual name.
 */
export class CreateRecord extends WithFields {
  readonly #table: string;
  readonly #id: Value;

  constructor(table: string, id: Value) {
    super();
    this.#table = name('a table', table);
    this.#id = id;
  }

  render(): Rendered {
    this.demandFields('CREATE');
    const binder = new Binder();
    // The identity binds first, before any field.
    const id = binder.bind(this.#id);
    return {
      script: `CREATE ${this.#table}:${id} = ${object(this.fields, binder)};`,
      parameters: binder.parameters,
    };
  }
}

/** `CREATE <table> = { … }` — the store allocates the identity. */
export class CreateInTable extends WithFields {
  readonly #table: string;

  constructor(table: string) {
    super();
    this.#table = name('a table', table);
  }

  render(): Rendered {
    this.demandFields('CREATE');
    const binder = new Binder();
    return {
      script: `CREATE ${this.#table} = ${object(this.fields, binder)};`,
      parameters: binder.parameters,
    };
  }
}

/**
 * `UPDATE <table>:$p0 SET field = $p1, …`
 *
 * `SET` changes the named fields only. A caller who wants the whole record
 * replaced asks for `CREATE`, where the word says so.
 */
export class UpdateRecord extends WithFields {
  readonly #table: string;
  readonly #id: Value;

  constructor(table: string, id: Value) {
    super();
    this.#table = name('a table', table);
    this.#id = id;
  }

  render(): Rendered {
    this.demandFields('UPDATE');
    const binder = new Binder();
    const id = binder.bind(this.#id);
    const assignments = ordered(this.fields).map(
      ([field, value]) => `${field} = ${binder.bind(value)}`,
    );
    return {
      script: `UPDATE ${this.#table}:${id} SET ${assignments.join(', ')};`,
      parameters: binder.parameters,
    };
  }
}

/** `DELETE <table>:$p0` — one record, named by the identity it was given. */
export class DeleteRecord {
  readonly #table: string;
  readonly #id: Value;

  constructor(table: string, id: Value) {
    this.#table = name('a table', table);
    this.#id = id;
  }

  render(): Rendered {
    const binder = new Binder();
    return {
      script: `DELETE ${this.#table}:${binder.bind(this.#id)};`,
      parameters: binder.parameters,
    };
  }
}

export function select(table: string): Select {
  return new Select(table);
}

export function createRecord(table: string, id: Value): CreateRecord {
  return new CreateRecord(table, id);
}

export function createInTable(table: string): CreateInTable {
  return new CreateInTable(table);
}

export function updateRecord(table: string, id: Value): UpdateRecord {
  return new UpdateRecord(table, id);
}

export function deleteRecord(table: string, id: Value): DeleteRecord {
  return new DeleteRecord(table, id);
}
