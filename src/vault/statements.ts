import type { Value } from '../value.ts';

/**
 * The statements a vault handle sends (vault contract §3), rendered in one place.
 *
 * Every id, value, recipient name and key is bound. Only checked names are
 * written into the text: the vault and an actor bare, a field **quoted** — a
 * vault is exactly where somebody declares a field with a word the language
 * reserves (`password`), and a checked name holds no quote, so quoting it cannot
 * change how the node reads it.
 */
export type Rendered = [string, Map<string, Value>];

/** The most ids one listing may ask for (§3.1). */
export const MOST_IDS = 10_000;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An argument the vault contract refuses before sending anything (§6). */
export class VaultArgumentError extends Error {
  override readonly name = 'VaultArgumentError';
  readonly reason: 'not-a-name' | 'bad-limit' | 'no-fields';

  constructor(reason: VaultArgumentError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

function checked(what: string, name: string): string {
  if (!NAME.test(name)) {
    throw new VaultArgumentError(
      'not-a-name',
      `${JSON.stringify(name)} is not a name, and ${what} must be one`,
    );
  }
  return name;
}

function tenancy(namespace: string, database: string): string {
  return `USE NAMESPACE ${checked('a namespace', namespace)}; USE DATABASE ${checked('a database', database)}; `;
}

const encoder = new TextEncoder();

/** Field names in ascending byte order (query-builder §4.8), each checked. */
function sortedFields(names: Iterable<string>): string[] {
  const byBytes = (a: string, b: string): number => {
    const [x, y] = [encoder.encode(a), encoder.encode(b)];
    for (let at = 0; at < Math.min(x.length, y.length); at++) {
      if (x[at] !== y[at]) return (x[at] ?? 0) - (y[at] ?? 0);
    }
    return x.length - y.length;
  };
  return [...names].map((name) => checked('a field', name)).sort(byBytes);
}

/** `INFO FOR AUDIT [BY actor]` (§3.5), with the actor checked and written in. */
export function auditStatement(
  namespace: string,
  database: string,
  by?: string,
): Rendered {
  const use = tenancy(namespace, database);
  if (by === undefined) return [`${use}INFO FOR AUDIT;`, new Map()];
  return [`${use}INFO FOR AUDIT BY ${checked('an actor', by)};`, new Map()];
}

export class VaultStatements {
  readonly #tenancy: string;
  readonly #vault: string;

  constructor(namespace: string, database: string, vault: string) {
    // Sent with every statement: a connection that reconnected has forgotten
    // any earlier USE.
    this.#tenancy = tenancy(namespace, database);
    this.#vault = checked('a vault', vault);
  }

  list(after?: Value, limit?: number): Rendered {
    let clauses = '';
    const given = new Map<string, Value>();
    if (after !== undefined) {
      clauses += ` AFTER ${this.#vault}:$after`;
      given.set('after', after);
    }
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MOST_IDS) {
        throw new VaultArgumentError('bad-limit', 'a listing asks for 1 to 10000 ids');
      }
      clauses += ` LIMIT ${limit}`;
    }
    return [`${this.#tenancy}INFO FOR VAULT ${this.#vault} RECORDS${clauses};`, given];
  }

  reveal(id: Value, fields: readonly string[]): Rendered {
    const names = sortedFields(fields);
    const which = names.length > 0 ? names.map((name) => `'${name}'`).join(', ') : '*';
    return [
      `${this.#tenancy}REVEAL ${which} FROM ${this.#vault}:$id;`,
      new Map([['id', id]]),
    ];
  }

  write(id: Value, fields: ReadonlyMap<string, Value>): Rendered {
    if (fields.size === 0) {
      throw new VaultArgumentError('no-fields', 'a write sets at least one field');
    }
    const given = new Map<string, Value>([['id', id]]);
    const pairs = sortedFields(fields.keys()).map((name, index) => {
      const value = fields.get(name);
      if (value !== undefined) given.set(`f${index}`, value);
      return `'${name}': $f${index}`;
    });
    return [
      `${this.#tenancy}UPSERT ${this.#vault}:$id MERGE { ${pairs.join(', ')} };`,
      given,
    ];
  }

  recipients(id: Value): Rendered {
    return [
      `${this.#tenancy}INFO FOR RECIPIENTS OF ${this.#vault}:$id;`,
      new Map([['id', id]]),
    ];
  }

  addRecipient(id: Value, name: string, key: Uint8Array): Rendered {
    return [
      `${this.#tenancy}ADD RECIPIENT $name TO ${this.#vault}:$id KEY $key;`,
      new Map<string, Value>([
        ['id', id],
        ['name', { kind: 'string', value: name }],
        ['key', { kind: 'bytes', value: key }],
      ]),
    ];
  }

  removeRecipient(id: Value, name: string): Rendered {
    return [
      `${this.#tenancy}REMOVE RECIPIENT $name FROM ${this.#vault}:$id;`,
      new Map<string, Value>([
        ['id', id],
        ['name', { kind: 'string', value: name }],
      ]),
    ];
  }
}
