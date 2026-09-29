/**
 * A space used as a cache, a counter and a lock — cache contract 1.0
 * (`spec/cache-v1.md` in the protocol repository).
 *
 * A {@link Cache} uses a connection the caller holds and sends one statement per
 * call, with its own `USE`, so a connection that reconnected underneath it cannot
 * read another database. Every key, value, duration and holder is bound.
 *
 * Two things a cache over this store must know, and that this class makes hard
 * to get wrong:
 *
 * - **A plain `set` clears an expiry the key had.** Pass `ttlMs` again on every
 *   write that must keep one.
 * - **A lock is a lease, not a mutex.** Past its ttl another holder may take it
 *   and neither is told. {@link Lease.release} is an expiring conditional write,
 *   never a delete: a delete after the lease lapsed would remove the next
 *   holder's lock, and a hand-back with no expiry would make the key permanent.
 *
 * A ttl is milliseconds.
 */

import type { Connection } from './connection.ts';
import type { Value } from './value.ts';

/** The most keys one listing may ask for (§2). */
const MOST_KEYS = 1000;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How long a key has left: a span, never, or no key at all. */
export type Ttl =
  { kind: 'expires'; ms: number } | { kind: 'never' } | { kind: 'absent' };

/** An argument the cache contract refuses before sending (§1, §2). */
export class CacheArgumentError extends Error {
  override readonly name = 'CacheArgumentError';
}

type Rendered = [string, Map<string, Value>];

/** A ttl in milliseconds as the store's duration, refused unless positive (§2). */
export function duration(ttlMs: number): Value {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new CacheArgumentError(
      'a ttl must be a positive number of milliseconds: a zero or negative one would remove the key',
    );
  }
  const nanosTotal = BigInt(Math.round(ttlMs * 1_000_000));
  return {
    kind: 'duration',
    seconds: nanosTotal / 1_000_000_000n,
    nanos: Number(nanosTotal % 1_000_000_000n),
  };
}

/**
 * A key as the wire spells it, back into the string this handle wrote (§2): a
 * quoted text key loses its quotes and its two escapes; any other kind is
 * returned as it came.
 */
export function unquoted(spelled: string): string {
  if (spelled.length < 2 || !spelled.startsWith("'") || !spelled.endsWith("'")) {
    return spelled;
  }
  let out = '';
  let escaped = false;
  for (const character of spelled.slice(1, -1)) {
    if (escaped) {
      out += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else {
      out += character;
    }
  }
  return out;
}

const text = (value: string): Value => ({ kind: 'string', value });

/** The statements a cache sends (§2), rendered in one place. */
export class CacheStatements {
  readonly #tenancy: string;
  readonly #space: string;

  constructor(namespace: string, database: string, space: string) {
    for (const [what, name] of [
      ['a namespace', namespace],
      ['a database', database],
      ['a space', space],
    ] as const) {
      if (!NAME.test(name)) {
        throw new CacheArgumentError(
          `${JSON.stringify(name)} is not a name, and ${what} must be one`,
        );
      }
    }
    // Sent with every statement: a connection that reconnected has forgotten
    // any earlier USE (§1).
    this.#tenancy = `USE NAMESPACE ${namespace}; USE DATABASE ${database}; `;
    this.#space = space;
  }

  #keyed(statement: string, key: string): Rendered {
    return [`${this.#tenancy}${statement}`, new Map([['k', text(key)]])];
  }

  get(key: string): Rendered {
    return this.#keyed(`GET ${this.#space}:$k;`, key);
  }

  set(
    key: string,
    value: Value,
    condition = '',
    expected?: Value,
    ttl?: Value,
  ): Rendered {
    const expiry = ttl === undefined ? '' : ' EXPIRE $t';
    const [script, given] = this.#keyed(
      `SET ${this.#space}:$k = $v${condition}${expiry};`,
      key,
    );
    given.set('v', value);
    if (expected !== undefined) given.set('e', expected);
    if (ttl !== undefined) given.set('t', ttl);
    return [script, given];
  }

  delete(key: string): Rendered {
    return this.#keyed(`DELETE ${this.#space}:$k RETURN BEFORE;`, key);
  }

  incr(key: string, by: bigint): Rendered {
    const [script, given] = this.#keyed(`INCR ${this.#space}:$k BY $n;`, key);
    given.set('n', { kind: 'integer', value: by });
    return [script, given];
  }

  ttl(key: string): Rendered {
    return this.#keyed(`RETURN TTL ${this.#space}:$k;`, key);
  }

  expire(key: string, ttl: Value): Rendered {
    const [script, given] = this.#keyed(`EXPIRE ${this.#space}:$k $t;`, key);
    given.set('t', ttl);
    return [script, given];
  }

  persist(key: string): Rendered {
    return this.#keyed(`PERSIST ${this.#space}:$k;`, key);
  }

  /** `limit` is checked by the caller to lie in 1–1000. */
  keys(prefix: string | undefined, after: string | undefined, limit: number): Rendered {
    let script = `${this.#tenancy}KEYS FROM ${this.#space}`;
    const given = new Map<string, Value>();
    if (prefix !== undefined && prefix !== '') {
      script += ' PREFIX $p';
      given.set('p', text(prefix));
    }
    if (after !== undefined) {
      script += ' AFTER $a';
      given.set('a', text(after));
    }
    return [`${script} LIMIT ${limit};`, given];
  }

  lock(key: string, holder: string, ttl: Value): Rendered {
    return this.#held(
      `SET ${this.#space}:$k = $h IF ABSENT EXPIRE $t;`,
      key,
      holder,
      ttl,
    );
  }

  extend(key: string, holder: string, ttl: Value): Rendered {
    return this.#held(
      `SET ${this.#space}:$k = $h IF = $h EXPIRE $t;`,
      key,
      holder,
      ttl,
    );
  }

  /** Never a delete and never a write without an expiry (§4). */
  release(key: string, holder: string): Rendered {
    return this.#held(
      `SET ${this.#space}:$k = 'free' IF = $h EXPIRE 1ms;`,
      key,
      holder,
    );
  }

  #held(statement: string, key: string, holder: string, ttl?: Value): Rendered {
    const [script, given] = this.#keyed(statement, key);
    given.set('h', text(holder));
    if (ttl !== undefined) given.set('t', ttl);
    return [script, given];
  }
}

/** 128 bits unique to one lease, in lowercase hex (§4). */
function freshHolder(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A lock held by this caller until its ttl passes (§4). */
export class Lease {
  readonly key: string;
  readonly holder: string;
  readonly ttlMs: number;
  readonly #cache: Cache;

  /** @internal Made by {@link Cache.lock}. */
  constructor(cache: Cache, key: string, holder: string, ttlMs: number) {
    this.#cache = cache;
    this.key = key;
    this.holder = holder;
    this.ttlMs = ttlMs;
  }

  /** Hold it for another ttl (its own when none is given); `false` means the lease was already lost. */
  extend(ttlMs?: number): Promise<boolean> {
    return this.#cache.extendLease(this, ttlMs ?? this.ttlMs);
  }

  /** Give it back; whether it was still held. */
  release(): Promise<boolean> {
    return this.#cache.releaseLease(this);
  }
}

/** The space `space` in `namespace`/`database`, over a connection the caller holds. */
export class Cache {
  readonly #statements: CacheStatements;
  readonly #connection: Connection;

  constructor(
    connection: Connection,
    options: { namespace: string; database: string; space: string },
  ) {
    this.#statements = new CacheStatements(
      options.namespace,
      options.database,
      options.space,
    );
    this.#connection = connection;
  }

  /** The value under `key`, or `undefined` when there is no such key. */
  async get(key: string): Promise<Value | undefined> {
    const found = await this.#value(this.#statements.get(key));
    return found.kind === 'none' ? undefined : found;
  }

  /** Store `value`, expiring after `ttlMs` if given — and clearing any expiry the key had if not. */
  async set(
    key: string,
    value: Value,
    options: { ttlMs?: number } = {},
  ): Promise<void> {
    await this.#value(
      this.#statements.set(key, value, '', undefined, lasting(options.ttlMs)),
    );
  }

  /** Store `value` only if there is no `key`; whether it was stored. */
  setIfAbsent(
    key: string,
    value: Value,
    options: { ttlMs?: number } = {},
  ): Promise<boolean> {
    return this.#flag(
      this.#statements.set(key, value, ' IF ABSENT', undefined, lasting(options.ttlMs)),
    );
  }

  /** Store `value` only if there is a `key`; whether it was stored. */
  setIfPresent(
    key: string,
    value: Value,
    options: { ttlMs?: number } = {},
  ): Promise<boolean> {
    return this.#flag(
      this.#statements.set(
        key,
        value,
        ' IF PRESENT',
        undefined,
        lasting(options.ttlMs),
      ),
    );
  }

  /** Store `value` only if `key` holds `expected`; whether it was stored. */
  compareAndSet(
    key: string,
    expected: Value,
    value: Value,
    options: { ttlMs?: number } = {},
  ): Promise<boolean> {
    return this.#flag(
      this.#statements.set(key, value, ' IF = $e', expected, lasting(options.ttlMs)),
    );
  }

  /** Remove `key`; whether there was one. A key holding `NULL` is one. */
  async delete(key: string): Promise<boolean> {
    return (await this.#value(this.#statements.delete(key))).kind !== 'none';
  }

  /** Add `by` — a missing key counts from zero — and answer the new value. An expiry the key had is kept. */
  async incr(key: string, by: bigint = 1n): Promise<bigint> {
    const found = await this.#value(this.#statements.incr(key, by));
    if (found.kind !== 'integer')
      throw new TypeError(`an increment answered ${found.kind}`);
    return found.value;
  }

  /** How long `key` has left — the store's two absences kept apart. */
  async ttl(key: string): Promise<Ttl> {
    const found = await this.#value(this.#statements.ttl(key));
    switch (found.kind) {
      case 'none':
        return { kind: 'absent' };
      case 'null':
        return { kind: 'never' };
      case 'duration':
        return {
          kind: 'expires',
          ms: Number(found.seconds) * 1000 + found.nanos / 1_000_000,
        };
      default:
        throw new TypeError(`a ttl answered ${found.kind}`);
    }
  }

  /** Let `key` expire after `ttlMs`; whether there was a key. */
  expire(key: string, ttlMs: number): Promise<boolean> {
    return this.#flag(this.#statements.expire(key, duration(ttlMs)));
  }

  /** Make `key` never expire; whether there was a key. */
  persist(key: string): Promise<boolean> {
    return this.#flag(this.#statements.persist(key));
  }

  /** Up to `limit` keys (1–1000) in key order, starting with `prefix` (none or empty: every key) and after `after`. */
  async keys(
    options: { prefix?: string; after?: string; limit?: number } = {},
  ): Promise<string[]> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > MOST_KEYS) {
      throw new CacheArgumentError('a key listing asks for 1 to 1000 keys');
    }
    const reply = await this.#execute(
      this.#statements.keys(options.prefix, options.after, limit),
    );
    const answered = reply.at(-1);
    if (answered?.kind !== 'keys')
      throw new TypeError(`a key listing answered ${answered?.kind}`);
    return answered.keys.map(unquoted);
  }

  /**
   * The value under `key`, or — when there is none — what `loader` makes, stored
   * for `ttlMs` if nobody stored first (§3).
   *
   * Racing callers are not coordinated: each that misses runs its loader, the
   * first to store wins, and the others answer the winner's value.
   */
  async getOrSet(
    key: string,
    ttlMs: number,
    loader: () => Value | Promise<Value>,
  ): Promise<Value> {
    const found = await this.get(key);
    if (found !== undefined) return found;
    const made = await loader();
    if (await this.setIfAbsent(key, made, { ttlMs })) return made;
    // Somebody stored first — or stored and it has already expired.
    return (await this.get(key)) ?? made;
  }

  /** Take the lock `key` for `ttlMs` as `holder` (a fresh unique one by default); the lease, or `undefined` when held. */
  async lock(key: string, ttlMs: number, holder?: string): Promise<Lease | undefined> {
    if (holder === '') throw new CacheArgumentError("a lock's holder is not empty");
    const who = holder ?? freshHolder();
    const taken = await this.#flag(this.#statements.lock(key, who, duration(ttlMs)));
    return taken ? new Lease(this, key, who, ttlMs) : undefined;
  }

  /** @internal Used by {@link Lease.extend}. */
  extendLease(lease: Lease, ttlMs: number): Promise<boolean> {
    return this.#flag(
      this.#statements.extend(lease.key, lease.holder, duration(ttlMs)),
    );
  }

  /** @internal Used by {@link Lease.release}. */
  releaseLease(lease: Lease): Promise<boolean> {
    return this.#flag(this.#statements.release(lease.key, lease.holder));
  }

  async #execute([script, given]: Rendered) {
    const reply = await this.#connection.execute(script, given);
    if (reply.kind !== 'answer') {
      throw new TypeError(
        'a cache statement was answered by a redirect to another node',
      );
    }
    return reply.outcomes;
  }

  async #value(rendered: Rendered): Promise<Value> {
    const answered = (await this.#execute(rendered)).at(-1);
    if (answered?.kind === 'value') return answered.value;
    if (answered?.kind === 'done') return { kind: 'none' };
    throw new TypeError(`a cache statement answered ${answered?.kind}`);
  }

  async #flag(rendered: Rendered): Promise<boolean> {
    const found = await this.#value(rendered);
    if (found.kind !== 'bool')
      throw new TypeError(`a conditional write answered ${found.kind}`);
    return found.value;
  }
}

function lasting(ttlMs: number | undefined): Value | undefined {
  return ttlMs === undefined ? undefined : duration(ttlMs);
}
