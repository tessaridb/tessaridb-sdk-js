/**
 * A vault — vault contract 1.0 (`spec/vault-v1.md` in the protocol repository).
 *
 * Two halves. The store's acts — {@link vaultStatus}, {@link unseal},
 * {@link seal}, {@link changePassphrase} — go in a frame of their own
 * (protocol §3.14), so a passphrase is a field and never a statement: statement
 * text is what a console keeps and a client logs on failure. A {@link Vault}
 * then lists, reveals, writes and shares the records of one vault with
 * statements whose every id and value is bound, and acts on that vault alone
 * when it carries its own passphrase.
 *
 * What a vault promises, said as narrowly as it is true: the stored bytes,
 * backups and replicas are ciphertext; a running node that is unsealed can
 * decrypt, because it must to answer a reveal. An unseal lasts the node's period
 * and then closes by itself. A refusal after a run of wrong passphrases means
 * **wait**, and is not retried here. A passphrase given to these functions is
 * sent and dropped, and is in no error this package raises.
 */
import type { Connection } from './connection.ts';
import { ProtocolError } from './error.ts';
import type { Value } from './value.ts';
import { frameBody, readStatus } from './vault/frame.ts';
import type { Place, VaultAct, VaultStatus } from './vault/frame.ts';
import { VaultStatements, auditStatement } from './vault/statements.ts';
import type { Rendered } from './vault/statements.ts';

async function act(
  conn: Connection,
  what: VaultAct,
  place?: Place,
): Promise<VaultStatus> {
  return readStatus(
    await conn.vaultFrame((credentials) => frameBody(credentials, what, place)),
  );
}

/** Whether the node can open secrets with the store's key, and until when. */
export function vaultStatus(conn: Connection): Promise<VaultStatus> {
  return act(conn, { act: 'status' });
}

/** Present the store's passphrase; the first one ever presented becomes it (`initialised`). */
export function unseal(conn: Connection, passphrase: string): Promise<VaultStatus> {
  return act(conn, { act: 'unseal', passphrase });
}

/** Drop the store's key: nothing in its custody can be revealed until the next unseal. */
export function seal(conn: Connection): Promise<VaultStatus> {
  return act(conn, { act: 'seal' });
}

/** Wrap the store's key under a new passphrase. No secret is re-encrypted. */
export function changePassphrase(
  conn: Connection,
  current: string,
  next: string,
): Promise<VaultStatus> {
  return act(conn, { act: 'change', current, next });
}

/** The store's trail of vault reads, optionally one user's. Answered only to a store-wide administrator. */
export async function vaultAudit(
  conn: Connection,
  namespace: string,
  database: string,
  by?: string,
): Promise<Value[]> {
  const report = await valueOf(conn, auditStatement(namespace, database, by));
  const entries = report.kind === 'object' ? report.fields.get('audit') : undefined;
  if (entries?.kind !== 'array')
    throw new ProtocolError('an audit answer holds an array');
  return entries.items;
}

/** One page of a vault's record ids, in key order; `next` is absent on the last page. */
export interface Page {
  ids: Value[];
  next?: Value;
}

/** A record id as a caller writes it: a string, an integer, or any value. */
export type IdLike = string | bigint | Value;

function idOf(id: IdLike): Value {
  if (typeof id === 'string') return { kind: 'string', value: id };
  if (typeof id === 'bigint') return { kind: 'integer', value: id };
  return id;
}

/**
 * One vault in a namespace and database, over a connection the caller holds.
 * Every call sends its own `USE`, so a connection that reconnected underneath
 * cannot read another database. The three names are checked here.
 */
export class Vault {
  readonly #conn: Connection;
  readonly #statements: VaultStatements;
  readonly #place: Place;

  constructor(conn: Connection, namespace: string, database: string, vault: string) {
    this.#conn = conn;
    this.#statements = new VaultStatements(namespace, database, vault);
    this.#place = [namespace, database, vault];
  }

  /** This vault's status; `custody` says what opens it, and for `store` the state is the store's. */
  status(): Promise<VaultStatus> {
    return act(this.#conn, { act: 'status' }, this.#place);
  }

  /**
   * Unseal this vault with its own passphrase. One in the store's custody is
   * refused rather than unsealed through the store, which would open every other
   * vault the store holds.
   */
  unseal(passphrase: string): Promise<VaultStatus> {
    return act(this.#conn, { act: 'unseal', passphrase }, this.#place);
  }

  /** Seal this vault; the store and every other vault stay as they were. */
  seal(): Promise<VaultStatus> {
    return act(this.#conn, { act: 'seal' }, this.#place);
  }

  /** Wrap this vault's key under a new passphrase; no secret is re-encrypted. */
  changePassphrase(current: string, next: string): Promise<VaultStatus> {
    return act(this.#conn, { act: 'change', current, next }, this.#place);
  }

  /** One page of ids after `after` (the previous page's `next`), 1 to 10000 of them. */
  async list(
    options: { after?: Value | undefined; limit?: number } = {},
  ): Promise<Page> {
    const report = await valueOf(
      this.#conn,
      this.#statements.list(options.after, options.limit),
    );
    const ids = report.kind === 'object' ? report.fields.get('records') : undefined;
    if (report.kind !== 'object' || ids?.kind !== 'array') {
      throw new ProtocolError('a listing holds an array of ids');
    }
    const next = report.fields.get('next');
    return next === undefined || next.kind === 'none'
      ? { ids: ids.items }
      : { ids: ids.items, next };
  }

  /** The named secret fields of one record, or every secret field when none are named. */
  async reveal(
    id: IdLike,
    fields: readonly string[] = [],
  ): Promise<Map<string, Value>> {
    const revealed = await valueOf(
      this.#conn,
      this.#statements.reveal(idOf(id), fields),
    );
    if (revealed.kind !== 'object')
      throw new ProtocolError('a reveal answers an object');
    return revealed.fields;
  }

  /** Set these fields, creating the record when absent and keeping every other field and recipient. */
  async write(id: IdLike, fields: ReadonlyMap<string, Value>): Promise<void> {
    await run(this.#conn, this.#statements.write(idOf(id), fields));
  }

  /** Who may one day open this record: name → the key material they hold. */
  async recipients(id: IdLike): Promise<Map<string, Uint8Array>> {
    const report = await valueOf(this.#conn, this.#statements.recipients(idOf(id)));
    const held = report.kind === 'object' ? report.fields.get('recipients') : undefined;
    if (held?.kind !== 'object')
      throw new ProtocolError('recipients are names to bytes');
    const out = new Map<string, Uint8Array>();
    for (const [name, key] of held.fields) {
      if (key.kind !== 'bytes')
        throw new ProtocolError('recipients are names to bytes');
      out.set(name, key.value);
    }
    return out;
  }

  /** Add a recipient; a name already present is refused, never replaced. */
  async addRecipient(id: IdLike, name: string, key: Uint8Array): Promise<void> {
    await run(this.#conn, this.#statements.addRecipient(idOf(id), name, key));
  }

  /** Remove a recipient; one that is not there is refused, never answered ok. */
  async removeRecipient(id: IdLike, name: string): Promise<void> {
    await run(this.#conn, this.#statements.removeRecipient(idOf(id), name));
  }
}

async function run(conn: Connection, [script, given]: Rendered) {
  const reply = await conn.execute(script, given);
  if (reply.kind !== 'answer')
    throw new ProtocolError('a vault statement was answered by a redirect');
  return reply.outcomes;
}

async function valueOf(conn: Connection, rendered: Rendered): Promise<Value> {
  const answered = (await run(conn, rendered)).at(-1);
  if (answered?.kind === 'value') return answered.value;
  throw new ProtocolError(`a vault statement answered ${answered?.kind ?? 'nothing'}`);
}
