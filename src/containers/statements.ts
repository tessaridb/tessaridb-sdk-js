/** The container calls' statements, as cache contract §2a writes them. */

import type { Value } from '../value.ts';

export type Rendered = [string, Map<string, Value>];

const text = (value: string): Value => ({ kind: 'string', value });
export const integer = (value: number | bigint): Value => ({
  kind: 'integer',
  value: BigInt(value),
});
export const float = (value: number): Value => ({ kind: 'float', value });

/** An argument the container calls refuse before sending (§2a). */
export class ContainerArgumentError extends Error {
  override readonly name = 'ContainerArgumentError';
}

/** The §2a statements, rendered in one place. Names are checked by the cache handle. */
export class ContainerStatements {
  readonly #tenancy: string;
  readonly #space: string;

  constructor(namespace: string, database: string, space: string) {
    this.#tenancy = `USE NAMESPACE ${namespace}; USE DATABASE ${database}; `;
    this.#space = space;
  }

  #bound(statement: string, key: string, extra: [string, Value][] = []): Rendered {
    return [`${this.#tenancy}${statement}`, new Map([['k', text(key)], ...extra])];
  }

  #numbered(statement: string, key: string, prefix: string, values: Value[]): Rendered {
    const given = new Map<string, Value>([['k', text(key)]]);
    const names = values.map((value, at) => {
      given.set(`${prefix}${at}`, value);
      return `$${prefix}${at}`;
    });
    return [`${this.#tenancy}${statement.replace('{list}', names.join(', '))}`, given];
  }

  #paired(
    statement: string,
    key: string,
    [left, right]: [string, string],
    pairs: [Value, Value][],
  ): Rendered {
    const given = new Map<string, Value>([['k', text(key)]]);
    const written = pairs.map(([name, value], at) => {
      given.set(`${left}${at}`, name);
      given.set(`${right}${at}`, value);
      return `$${left}${at} = $${right}${at}`;
    });
    return [
      `${this.#tenancy}${statement.replace('{list}', written.join(', '))}`,
      given,
    ];
  }

  get(key: string): Rendered {
    return this.#bound(`GET ${this.#space}:$k;`, key);
  }

  listPush(key: string, values: Value[], front: boolean): Rendered {
    const end = front ? 'FRONT' : 'BACK';
    return this.#numbered(
      `LIST PUSH ${this.#space}:$k ${end} {list};`,
      key,
      'v',
      values,
    );
  }

  listPop(key: string, front: boolean, count?: number): Rendered {
    const end = front ? 'FRONT' : 'BACK';
    return count === undefined
      ? this.#bound(`LIST POP ${this.#space}:$k ${end};`, key)
      : this.#bound(`LIST POP ${this.#space}:$k ${end} LIMIT $n;`, key, [
          ['n', integer(count)],
        ]);
  }

  listRange(key: string, start: number, count: number): Rendered {
    return this.#bound(`RETURN array::slice(GET ${this.#space}:$k, $i, $n);`, key, [
      ['i', integer(start)],
      ['n', integer(count)],
    ]);
  }

  listAt(key: string, index: number): Rendered {
    return this.#bound(`RETURN array::at(GET ${this.#space}:$k, $i);`, key, [
      ['i', integer(index)],
    ]);
  }

  listLen(key: string): Rendered {
    return this.#bound(`RETURN array::len(GET ${this.#space}:$k);`, key);
  }

  listRemove(key: string, value: Value, count?: number): Rendered {
    return count === undefined
      ? this.#bound(`LIST REMOVE ${this.#space}:$k $v;`, key, [['v', value]])
      : this.#bound(`LIST REMOVE ${this.#space}:$k $v LIMIT $n;`, key, [
          ['v', value],
          ['n', integer(count)],
        ]);
  }

  listTrim(key: string, start: number, stop: number): Rendered {
    return this.#bound(`LIST TRIM ${this.#space}:$k FROM $i TO $j;`, key, [
      ['i', integer(start)],
      ['j', integer(stop)],
    ]);
  }

  hashSet(key: string, fields: Map<string, Value>): Rendered {
    const pairs = [...fields].map(([name, value]): [Value, Value] => [
      text(name),
      value,
    ]);
    return this.#paired(`HASH SET ${this.#space}:$k {list};`, key, ['f', 'v'], pairs);
  }

  hashGet(key: string, field: string): Rendered {
    return this.#bound(`RETURN object::get(GET ${this.#space}:$k, $f);`, key, [
      ['f', text(field)],
    ]);
  }

  hashRemove(key: string, fields: string[]): Rendered {
    return this.#numbered(
      `HASH REMOVE ${this.#space}:$k {list};`,
      key,
      'f',
      fields.map(text),
    );
  }

  hashIncr(key: string, field: string, by: bigint): Rendered {
    return this.#bound(`HASH INCR ${this.#space}:$k $f BY $n;`, key, [
      ['f', text(field)],
      ['n', integer(by)],
    ]);
  }

  hashLen(key: string): Rendered {
    return this.#bound(`RETURN object::len(GET ${this.#space}:$k);`, key);
  }

  members(verb: 'ADD' | 'REMOVE', key: string, members: Value[]): Rendered {
    return this.#numbered(
      `MEMBERS ${verb} ${this.#space}:$k {list};`,
      key,
      'v',
      members,
    );
  }

  membersHas(key: string, member: Value): Rendered {
    return this.#bound(`RETURN $v IN GET ${this.#space}:$k;`, key, [['v', member]]);
  }

  membersLen(key: string): Rendered {
    return this.#bound(`RETURN set::len(GET ${this.#space}:$k);`, key);
  }

  scoresAdd(key: string, scores: Map<string, number>): Rendered {
    const pairs = [...scores].map(([member, score]): [Value, Value] => [
      text(member),
      float(score),
    ]);
    return this.#paired(`SCORES ADD ${this.#space}:$k {list};`, key, ['m', 'c'], pairs);
  }

  scoresIncr(key: string, member: string, by: number): Rendered {
    return this.#bound(`SCORES INCR ${this.#space}:$k $m BY $c;`, key, [
      ['m', text(member)],
      ['c', float(by)],
    ]);
  }

  scoresRemove(key: string, members: string[]): Rendered {
    return this.#numbered(
      `SCORES REMOVE ${this.#space}:$k {list};`,
      key,
      'm',
      members.map(text),
    );
  }

  scoresOf(fn: 'score' | 'rank', key: string, member: string): Rendered {
    return this.#bound(`RETURN scores::${fn}(GET ${this.#space}:$k, $m);`, key, [
      ['m', text(member)],
    ]);
  }

  scoresRange(key: string, start: number, stop: number): Rendered {
    return this.#bound(`RETURN scores::range(GET ${this.#space}:$k, $i, $j);`, key, [
      ['i', integer(start)],
      ['j', integer(stop)],
    ]);
  }

  /** An absent bound is written `NONE` in its place (§2a). */
  scoresBetween(key: string, low?: number, high?: number): Rendered {
    const extra: [string, Value][] = [];
    if (low !== undefined) extra.push(['lo', float(low)]);
    if (high !== undefined) extra.push(['hi', float(high)]);
    const lowText = low === undefined ? 'NONE' : '$lo';
    const highText = high === undefined ? 'NONE' : '$hi';
    return this.#bound(
      `RETURN scores::between(GET ${this.#space}:$k, ${lowText}, ${highText});`,
      key,
      extra,
    );
  }
}
