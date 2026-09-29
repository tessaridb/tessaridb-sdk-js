/**
 * Consuming a topic as a member of a consumer group — consumer contract 1.0
 * (`spec/consumer-v1.md` in the protocol repository).
 *
 * A {@link Consumer} reads a topic under a group the store holds, and calls a
 * handler once per message in the order the group hands them out. The group, not
 * the connection, keeps the state — the last position handed out and what is in
 * flight — so a process that crashes loses nothing it had not acknowledged, and
 * another under the same group name carries on.
 *
 * - `runAuto` acknowledges each message when the handler resolves, and hands it
 *   back when it throws or rejects: acknowledge after processing, at least once.
 * - `runManual` lets the handler decide by resolving to a {@link Settle}.
 *
 * The group itself is declared in the store (`DEFINE GROUP`), never by this
 * class: declaring it is a schema act that chooses a deadline no client can
 * guess.
 */

import type { Connection } from './connection.ts';
import type { Value } from './value.ts';

/** The first wait after a read that answered nothing, in milliseconds (§4.5). */
const FIRST_WAIT = 50;
/** The longest wait between reads that answer nothing, in milliseconds (§4.5). */
const LONGEST_WAIT = 1000;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP = /^[A-Za-z0-9_.:-]{1,128}$/;

/** One message, as the group handed it out. */
export interface Message {
  /** Its position in the topic, from 1 — with the topic and group names, a stable key for idempotence. */
  readonly position: bigint;
  readonly value: Value;
  /** How many times it has been handed out, 1 the first time. */
  readonly deliveries: bigint;
}

/** What a manual handler decided about a message. */
export type Settle =
  { kind: 'ack' } | { kind: 'nack'; delayMs?: number } | { kind: 'leave' };

/** A name the consumer will not write into a statement (§3): refused, never escaped. */
export class ConsumerNameError extends Error {
  override readonly name = 'ConsumerNameError';
  readonly position: 'a namespace' | 'a database' | 'a topic' | 'a group';
  readonly offending: string;

  constructor(position: ConsumerNameError['position'], offending: string) {
    super(`${JSON.stringify(offending)} is not a name, and ${position} must be one`);
    this.position = position;
    this.offending = offending;
  }
}

export interface ConsumerOptions {
  namespace: string;
  database: string;
  topic: string;
  group: string;
  /** Messages asked for per read; at least one. Defaults to 10. */
  batch?: number;
}

function whole(value: Value | undefined): bigint {
  if (value?.kind === 'integer' && value.value >= 0n) {
    return value.value;
  }
  throw new TypeError(`expected a whole number, got ${JSON.stringify(value?.kind)}`);
}

function message(body: Value): Message {
  if (body.kind !== 'object') {
    throw new TypeError(`a message answered ${body.kind}`);
  }
  return {
    position: whole(body.fields.get('position')),
    value: body.fields.get('value') ?? { kind: 'none' },
    deliveries: whole(body.fields.get('deliveries')),
  };
}

/** A member of a consumer group, reading one topic over one connection. */
export class Consumer {
  readonly #connection: Connection;
  /** Sent with every statement: a reconnected connection has forgotten any earlier USE (§5). */
  readonly #tenancy: string;
  readonly #topic: string;
  readonly #group: string;
  readonly #batch: number;
  #stopped = false;
  #wake: (() => void) | undefined;

  /**
   * The connection should already carry its credentials when the store is
   * closed: a wire connection proves who it is once and keeps that identity.
   */
  constructor(connection: Connection, options: ConsumerOptions) {
    for (const [position, name] of [
      ['a namespace', options.namespace],
      ['a database', options.database],
      ['a topic', options.topic],
    ] as const) {
      if (!NAME.test(name)) {
        throw new ConsumerNameError(position, name);
      }
    }
    if (!GROUP.test(options.group)) {
      throw new ConsumerNameError('a group', options.group);
    }
    this.#connection = connection;
    this.#tenancy = `USE NAMESPACE ${options.namespace}; USE DATABASE ${options.database}; `;
    this.#topic = options.topic;
    this.#group = options.group;
    this.#batch = Math.max(1, Math.trunc(options.batch ?? 10));
  }

  /**
   * Let the running handler finish (and, in auto mode, its acknowledgement be
   * sent), then stop reading. What is in flight returns to the group when its
   * deadline passes.
   */
  stop(): void {
    this.#stopped = true;
    this.#wake?.();
  }

  /** Call `handler` for each message: resolving acknowledges it, throwing hands it back at once. */
  async runAuto(handler: (message: Message) => unknown): Promise<void> {
    for (let messages = await this.#next(); messages; messages = await this.#next()) {
      for (const each of messages) {
        let failed = false;
        try {
          await handler(each);
        } catch {
          failed = true;
        }
        if (failed) {
          await this.nack([each.position]);
        } else {
          await this.ack([each.position]);
        }
        if (this.#stopped) {
          return;
        }
      }
    }
  }

  /** Call `handler` for each message and do what it resolves to. */
  async runManual(
    handler: (message: Message) => Settle | Promise<Settle>,
  ): Promise<void> {
    for (let messages = await this.#next(); messages; messages = await this.#next()) {
      for (const each of messages) {
        const decided = await handler(each);
        if (decided.kind === 'ack') {
          await this.ack([each.position]);
        } else if (decided.kind === 'nack') {
          await this.nack([each.position], decided.delayMs);
        }
        if (this.#stopped) {
          return;
        }
      }
    }
  }

  /** Acknowledge these positions; resolves to how many were in flight. One that was not counts nothing. */
  ack(positions: readonly bigint[]): Promise<bigint> {
    return this.#settle(
      `ACK ${this.#topic} FOR CONSUMER '${this.#group}' AT `,
      positions,
      '',
    );
  }

  /** Hand these positions back, now or after `delayMs`; resolves to how many were in flight. */
  nack(positions: readonly bigint[], delayMs?: number): Promise<bigint> {
    // A delay is a duration literal in the grammar, not a parameter, written from
    // a number formatted here and never from a caller's text.
    const millis = Math.trunc(delayMs ?? 0);
    const tail = millis > 0 ? ` DELAY ${millis}ms` : '';
    return this.#settle(
      `NACK ${this.#topic} FOR CONSUMER '${this.#group}' AT `,
      positions,
      tail,
    );
  }

  async #settle(
    statement: string,
    positions: readonly bigint[],
    tail: string,
  ): Promise<bigint> {
    if (positions.length === 0) {
      return 0n;
    }
    const parameters = new Map<string, Value>();
    const references = positions.map((position, index) => {
      parameters.set(`p${index}`, { kind: 'integer', value: position });
      return `$p${index}`;
    });
    const reply = await this.#connection.execute(
      `${this.#tenancy}${statement}${references.join(', ')}${tail};`,
      parameters,
    );
    const answered = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
    if (answered?.kind !== 'value') {
      throw new TypeError(
        `an acknowledgement answered ${answered?.kind ?? reply.kind}`,
      );
    }
    return whole(answered.value);
  }

  /** The next messages, waiting while there are none (§4.5); `undefined` once stopped. */
  async #next(): Promise<Message[] | undefined> {
    let wait = FIRST_WAIT;
    while (!this.#stopped) {
      const reply = await this.#connection.execute(
        `${this.#tenancy}READ FROM ${this.#topic} FOR CONSUMER '${this.#group}' LIMIT ${this.#batch};`,
      );
      const answered = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
      if (answered?.kind !== 'records') {
        throw new TypeError(`a group read answered ${answered?.kind ?? reply.kind}`);
      }
      const messages = answered.records.map((row) => message(row.value));
      if (messages.length > 0) {
        return messages;
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
