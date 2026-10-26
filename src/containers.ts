/**
 * A key holding a list, a hash, a set of members or a ranking — cache contract
 * 1.1, §2a.
 *
 * Writes are the node's container statements, atomic per key; reads are
 * functions over the key's value, so every call is still one statement. A read
 * of a key that is not there answers the empty form — an empty array, map or
 * set, `0`, `false` — and an element, field, score or rank that is not there
 * answers `undefined`.
 */

import type { Value } from './value.ts';
import {
  ContainerArgumentError,
  ContainerStatements,
  float,
  integer,
} from './containers/statements.ts';
import type { Rendered } from './containers/statements.ts';

function some(items: { length: number } | { size: number }, reason: string): void {
  const count = 'length' in items ? items.length : items.size;
  if (count === 0) throw new ContainerArgumentError(reason);
}

function whole(value: number, reason: string, negative = false): void {
  if (!Number.isSafeInteger(value) || (!negative && value < 0)) {
    throw new ContainerArgumentError(reason);
  }
}

function finite(score: number): void {
  if (!Number.isFinite(score))
    throw new ContainerArgumentError('a score is a finite number');
}

function count(found: Value): number {
  if (found.kind === 'none') return 0;
  if (found.kind !== 'integer')
    throw new TypeError(`a container call answered ${found.kind}`);
  return Number(found.value);
}

function present(found: Value): Value | undefined {
  return found.kind === 'none' ? undefined : found;
}

function items(found: Value): Value[] {
  if (found.kind === 'none') return [];
  if (found.kind !== 'array')
    throw new TypeError(`a container read answered ${found.kind}`);
  return found.items;
}

function ranked(found: Value): [string, number][] {
  return items(found).map((pair) => {
    const [member, score] = pair.kind === 'array' ? pair.items : [];
    if (member?.kind !== 'string' || score?.kind !== 'float' || pair.kind !== 'array') {
      throw new TypeError('a ranking read answered something else');
    }
    return [member.value, score.value];
  });
}

/** The §2a calls; the cache handle extends this. */
export abstract class ContainerCalls {
  protected abstract readonly containers: ContainerStatements;
  protected abstract containerValue(rendered: Rendered): Promise<Value>;

  /** Push `values` at the back (or the front); the new length. */
  async listPush(
    key: string,
    values: Value[],
    options: { front?: boolean } = {},
  ): Promise<number> {
    some(values, 'a push needs a value');
    return count(
      await this.containerValue(
        this.containers.listPush(key, values, options.front ?? false),
      ),
    );
  }

  /** Take one element, or `undefined` when the list is not there. */
  async listPop(
    key: string,
    options: { front?: boolean } = {},
  ): Promise<Value | undefined> {
    return present(
      await this.containerValue(this.containers.listPop(key, options.front ?? true)),
    );
  }

  /** Take up to `count` elements, in the order taken. */
  async listPopMany(
    key: string,
    count_: number,
    options: { front?: boolean } = {},
  ): Promise<Value[]> {
    whole(count_, 'a count is not negative');
    return items(
      await this.containerValue(
        this.containers.listPop(key, options.front ?? true, count_),
      ),
    );
  }

  /** `count` elements from `start`. */
  async listRange(key: string, start: number, count_: number): Promise<Value[]> {
    whole(start, 'a range starts at or after the first element');
    whole(count_, 'a count is not negative');
    return items(
      await this.containerValue(this.containers.listRange(key, start, count_)),
    );
  }

  /** The element at `index`, a negative one counted from the back. */
  async listAt(key: string, index: number): Promise<Value | undefined> {
    whole(index, 'a position is a whole number', true);
    return present(await this.containerValue(this.containers.listAt(key, index)));
  }

  /** How many elements the list holds. */
  async listLen(key: string): Promise<number> {
    return count(await this.containerValue(this.containers.listLen(key)));
  }

  /** Remove `value` — every occurrence, or at most `count`; how many went. */
  async listRemove(
    key: string,
    value: Value,
    options: { count?: number } = {},
  ): Promise<number> {
    if (options.count !== undefined) whole(options.count, 'a count is not negative');
    return count(
      await this.containerValue(this.containers.listRemove(key, value, options.count)),
    );
  }

  /** Keep the elements from `start` to `stop`, both included, either counted from the back when negative. */
  async listTrim(key: string, start: number, stop: number): Promise<void> {
    whole(start, 'a position is a whole number', true);
    whole(stop, 'a position is a whole number', true);
    await this.containerValue(this.containers.listTrim(key, start, stop));
  }

  /** Set `fields`; how many were new. */
  async hashSet(key: string, fields: Map<string, Value>): Promise<number> {
    some(fields, 'a hash write needs a field');
    return count(await this.containerValue(this.containers.hashSet(key, fields)));
  }

  /** One field, or `undefined` when it is not there. */
  async hashGet(key: string, field: string): Promise<Value | undefined> {
    return present(await this.containerValue(this.containers.hashGet(key, field)));
  }

  /** Every field. */
  async hashGetAll(key: string): Promise<Map<string, Value>> {
    const found = await this.containerValue(this.containers.get(key));
    if (found.kind === 'none') return new Map();
    if (found.kind !== 'object')
      throw new TypeError(`a hash read answered ${found.kind}`);
    return found.fields;
  }

  /** Remove `fields`; how many went. */
  async hashRemove(key: string, fields: string[]): Promise<number> {
    some(fields, 'a hash removal needs a field');
    return count(await this.containerValue(this.containers.hashRemove(key, fields)));
  }

  /** Add `by` to a field; its new value. */
  async hashIncr(key: string, field: string, by: bigint = 1n): Promise<bigint> {
    const found = await this.containerValue(this.containers.hashIncr(key, field, by));
    if (found.kind !== 'integer')
      throw new TypeError(`an increment answered ${found.kind}`);
    return found.value;
  }

  /** How many fields the hash holds. */
  async hashLen(key: string): Promise<number> {
    return count(await this.containerValue(this.containers.hashLen(key)));
  }

  /** Add `members`; how many were new. */
  async membersAdd(key: string, members: Value[]): Promise<number> {
    some(members, 'a set write needs a member');
    return count(
      await this.containerValue(this.containers.members('ADD', key, members)),
    );
  }

  /** Remove `members`; how many went. */
  async membersRemove(key: string, members: Value[]): Promise<number> {
    some(members, 'a set removal needs a member');
    return count(
      await this.containerValue(this.containers.members('REMOVE', key, members)),
    );
  }

  /** Whether `member` is in the set. */
  async membersHas(key: string, member: Value): Promise<boolean> {
    const found = await this.containerValue(this.containers.membersHas(key, member));
    if (found.kind !== 'bool')
      throw new TypeError(`a membership answered ${found.kind}`);
    return found.value;
  }

  /** Every member. */
  async membersAll(key: string): Promise<Value[]> {
    const found = await this.containerValue(this.containers.get(key));
    if (found.kind === 'none') return [];
    if (found.kind !== 'set') throw new TypeError(`a set read answered ${found.kind}`);
    return found.items;
  }

  /** How many members the set holds. */
  async membersLen(key: string): Promise<number> {
    return count(await this.containerValue(this.containers.membersLen(key)));
  }

  /** Rank `scores` (member → score); how many members were new. */
  async scoresAdd(key: string, scores: Map<string, number>): Promise<number> {
    some(scores, 'a ranking write needs a member');
    for (const score of scores.values()) finite(score);
    return count(await this.containerValue(this.containers.scoresAdd(key, scores)));
  }

  /** Add `by` to a member's score; its new score. */
  async scoresIncr(key: string, member: string, by: number): Promise<number> {
    finite(by);
    const found = await this.containerValue(
      this.containers.scoresIncr(key, member, by),
    );
    if (found.kind !== 'float') throw new TypeError(`a score answered ${found.kind}`);
    return found.value;
  }

  /** Remove `members`; how many went. */
  async scoresRemove(key: string, members: string[]): Promise<number> {
    some(members, 'a ranking removal needs a member');
    return count(await this.containerValue(this.containers.scoresRemove(key, members)));
  }

  /** A member's score, or `undefined` when it is not ranked. */
  async scoresScore(key: string, member: string): Promise<number | undefined> {
    const found = await this.containerValue(
      this.containers.scoresOf('score', key, member),
    );
    if (found.kind === 'none') return undefined;
    if (found.kind !== 'float') throw new TypeError(`a score answered ${found.kind}`);
    return found.value;
  }

  /** A member's place from the lowest score, from 0, or `undefined`. */
  async scoresRank(key: string, member: string): Promise<number | undefined> {
    const found = await this.containerValue(
      this.containers.scoresOf('rank', key, member),
    );
    return found.kind === 'none' ? undefined : count(found);
  }

  /** The members at places `start` to `stop`, both included, either counted from the highest when negative. */
  async scoresRange(
    key: string,
    start: number,
    stop: number,
  ): Promise<[string, number][]> {
    whole(start, 'a position is a whole number', true);
    whole(stop, 'a position is a whole number', true);
    return ranked(
      await this.containerValue(this.containers.scoresRange(key, start, stop)),
    );
  }

  /** The members whose score is from `low` to `high`, both included, an absent bound leaving that side open. */
  async scoresBetween(
    key: string,
    options: { low?: number; high?: number } = {},
  ): Promise<[string, number][]> {
    return ranked(
      await this.containerValue(
        this.containers.scoresBetween(key, options.low, options.high),
      ),
    );
  }
}
