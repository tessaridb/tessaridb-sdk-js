/**
 * Taking work from a queue — queue contract 1.0 (`spec/queue-v1.md` in the
 * protocol repository).
 *
 * A {@link Queue} claims records from a queue the store holds, as one named
 * worker, and settles each one: `done` deletes it, `release` hands it back, now
 * or not before a delay. A worker that dies says nothing — its hold lapses after
 * the queue's `TIMEOUT` and the next claim takes the record — so the work is at
 * least once; key an outside effect on the queue name and the job's identity.
 *
 * - `runAuto`: resolving marks the record done, throwing hands it back at once.
 *   The attempt was counted at the claim, so a record that keeps failing reaches
 *   the queue's `ATTEMPTS` (and its dead letter, if it declares one).
 * - `runManual`: the handler resolves to a {@link Handled}.
 *
 * The queue itself is declared in the store (`DEFINE QUEUE`), never by this
 * class: declaring it chooses a timeout no client can guess.
 */

import type { Connection } from './connection.ts';
import { RefusalError } from './error.ts';
import { type Filter, renderFilter } from './query/filter.ts';
import { Binder } from './query/grammar.ts';
import type { Value } from './value.ts';

/** The first wait after a claim that took nothing, in milliseconds (§4.5). */
const FIRST_WAIT = 50;
/** The longest wait between claims that take nothing, in milliseconds (§4.5). */
const LONGEST_WAIT = 1000;
/** The most records one claim may take; the node refuses more. */
const CEILING = 500;
/** The three fields the engine keeps on a held record, not the work's own. */
const ENGINE = new Set(['attempts', 'claimed_until', 'claimed_by']);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORKER = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * One record a claim took. `identity` is the store's own spelling — `7`, `'a7'`,
 * `uuid '…'` — written back unchanged when it is settled (§2), so settle a job
 * only through the queue that claimed it.
 */
export interface Job {
  readonly identity: string;
  /** The record's own fields, without the engine's hold. */
  readonly value: Value;
  /** How many times it has been handed out, 1 the first time. */
  readonly attempts: bigint;
}

/** What a manual handler decided about a record. `afterMs` needs a NOT BEFORE field on the queue. */
export type Handled =
  { kind: 'done' } | { kind: 'release'; afterMs?: number } | { kind: 'leave' };

/** Something the worker will not write into a statement (§3): refused, never escaped. */
export class QueueArgumentError extends Error {
  override readonly name = 'QueueArgumentError';
  readonly reason: 'not-a-name' | 'not-a-count';
  readonly position: 'a namespace' | 'a database' | 'a queue' | 'a worker' | 'a count';
  readonly offending: string;

  constructor(
    reason: QueueArgumentError['reason'],
    position: QueueArgumentError['position'],
    offending: string,
  ) {
    super(
      reason === 'not-a-count'
        ? `${offending} is not a claim count: claim from 1 to 500 records at a time`
        : `${JSON.stringify(offending)} is not a name, and ${position} must be one`,
    );
    this.reason = reason;
    this.position = position;
    this.offending = offending;
  }
}

export interface QueueOptions {
  namespace: string;
  database: string;
  queue: string;
  worker: string;
  /** Records asked for per claim in the run loops, 1 to 500. Defaults to 10. */
  batch?: number;
  /** Take only records matching this filter in the run loops; its values are bound. */
  where?: Filter;
}

/**
 * The statements a worker sends (§2), rendered in one place, so the shared
 * corpus (`queue-v1.json`) checking this class checks what actually goes out.
 * Not re-exported from the package.
 */
export class QueueStatements {
  /** Sent with every statement: a reconnected connection has forgotten any earlier USE (§5). */
  readonly #tenancy: string;
  readonly #queue: string;
  readonly #worker: string;

  constructor(
    options: Pick<QueueOptions, 'namespace' | 'database' | 'queue' | 'worker'>,
  ) {
    for (const [position, name] of [
      ['a namespace', options.namespace],
      ['a database', options.database],
      ['a queue', options.queue],
    ] as const) {
      if (!NAME.test(name)) {
        throw new QueueArgumentError('not-a-name', position, name);
      }
    }
    if (!WORKER.test(options.worker)) {
      throw new QueueArgumentError('not-a-name', 'a worker', options.worker);
    }
    this.#tenancy = `USE NAMESPACE ${options.namespace}; USE DATABASE ${options.database}; `;
    this.#queue = options.queue;
    this.#worker = options.worker;
  }

  claim(count: number, where?: Filter): [string, Map<string, Value>] {
    if (!Number.isInteger(count) || count < 1 || count > CEILING) {
      throw new QueueArgumentError('not-a-count', 'a count', String(count));
    }
    const binder = new Binder();
    const narrowed = where ? ` WHERE ${renderFilter(where, binder)}` : '';
    return [
      `${this.#tenancy}USE CONSUMER '${this.#worker}'; CLAIM ${count} FROM ${this.#queue}${narrowed};`,
      binder.parameters,
    ];
  }

  done(identity: string): string {
    return `${this.#tenancy}DELETE ${this.#queue}:${identity};`;
  }

  release(identity: string, afterMs?: number): string {
    // A delay is a duration literal written from a number formatted here, never
    // from a caller's text.
    const millis = Math.trunc(afterMs ?? 0);
    const tail = millis > 0 ? ` NOT BEFORE ${millis}ms` : '';
    return `${this.#tenancy}RELEASE ${this.#queue}:${identity} FOR CONSUMER '${this.#worker}'${tail};`;
  }
}

function job(identity: string, body: Value): Job {
  if (body.kind !== 'object') {
    throw new TypeError(`a claim answered ${body.kind}`);
  }
  const attempts = body.fields.get('attempts');
  if (attempts?.kind !== 'integer') {
    throw new TypeError('a claimed record carries no attempt count');
  }
  const work = new Map([...body.fields].filter(([field]) => !ENGINE.has(field)));
  return {
    identity,
    value: { kind: 'object', fields: work },
    attempts: attempts.value,
  };
}

/** A worker taking records from one queue over one connection. */
export class Queue {
  readonly #connection: Connection;
  readonly #statements: QueueStatements;
  readonly #batch: number;
  readonly #where: Filter | undefined;
  #stopped = false;
  #wake: (() => void) | undefined;

  constructor(connection: Connection, options: QueueOptions) {
    this.#statements = new QueueStatements(options);
    this.#connection = connection;
    this.#batch = options.batch ?? 10;
    this.#where = options.where;
  }

  /** Let the running handler finish, hand back the rest of the batch, then stop claiming. */
  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }

  /** Claim up to `count` records, narrowed by `where`; an empty list is an empty queue. */
  async claim(count = 1, where?: Filter): Promise<Job[]> {
    const reply = await this.#connection.execute(
      ...this.#statements.claim(count, where),
    );
    const answered = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
    if (answered?.kind !== 'records') {
      throw new TypeError(`a claim answered ${answered?.kind ?? reply.kind}`);
    }
    return answered.records.map((row) => job(row.identity, row.value));
  }

  /** The work is done: delete the record. */
  async done(job: Job): Promise<void> {
    await this.#connection.execute(this.#statements.done(job.identity));
  }

  /** Hand the record back, now or not before `afterMs`. */
  async release(job: Job, afterMs?: number): Promise<void> {
    await this.#connection.execute(this.#statements.release(job.identity, afterMs));
  }

  /** Call `handler` for each record: resolving marks it done, throwing hands it back at once. */
  async runAuto(handler: (job: Job) => unknown): Promise<void> {
    for (let jobs = await this.#next(); jobs; jobs = await this.#next()) {
      for (const [index, each] of jobs.entries()) {
        let failed = false;
        try {
          await handler(each);
        } catch {
          failed = true;
        }
        await (failed ? this.release(each) : this.done(each));
        if (this.#stopped) {
          return this.#handBack(jobs.slice(index + 1));
        }
      }
    }
  }

  /** Call `handler` for each record and do what it resolves to. */
  async runManual(handler: (job: Job) => Handled | Promise<Handled>): Promise<void> {
    for (let jobs = await this.#next(); jobs; jobs = await this.#next()) {
      for (const [index, each] of jobs.entries()) {
        const decided = await handler(each);
        if (decided.kind === 'done') {
          await this.done(each);
        } else if (decided.kind === 'release') {
          await this.release(each, decided.afterMs);
        }
        if (this.#stopped) {
          return this.#handBack(jobs.slice(index + 1));
        }
      }
    }
  }

  /** One statement each (§4.6): RELEASE ALL would reach live siblings. */
  async #handBack(unseen: readonly Job[]): Promise<void> {
    for (const each of unseen) {
      await this.release(each);
    }
  }

  /** The next records, waiting while there are none (§4.5); `undefined` once stopped. */
  async #next(): Promise<Job[] | undefined> {
    let wait = FIRST_WAIT;
    while (!this.#stopped) {
      let jobs: Job[] = [];
      try {
        jobs = await this.claim(this.#batch, this.#where);
      } catch (error) {
        // Two claims raced past what the store's register sees (§6).
        if (!(error instanceof RefusalError) || error.refusalClass !== 'retry') {
          throw error;
        }
      }
      if (jobs.length > 0) {
        return jobs;
      }
      // Woken early by stop(), so a stop during the wait is not held back.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = undefined;
      wait = Math.min(wait * 2, LONGEST_WAIT);
    }
    return undefined;
  }
}
