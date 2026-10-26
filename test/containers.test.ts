import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  Cache,
  ContainerArgumentError,
  ContainerStatements,
  connect,
} from '../src/index.ts';
import type { Value } from '../src/index.ts';

/**
 * The container calls' statements, byte for byte, as cache contract §2a writes
 * them, and — with `TESSARIDB_TEST_NODE` set — every call against a running node.
 */
const USE = 'USE NAMESPACE app; USE DATABASE main; ';
const str = (value: string): Value => ({ kind: 'string', value });
const texts = (...items: string[]): Value[] => items.map(str);

test('every container statement is the one the contract writes', () => {
  const s = new ContainerStatements('app', 'main', 'cache');
  const cases: [[string, Map<string, Value>], string, string[]][] = [
    [
      s.listPush('k', texts('a', 'b'), false),
      'LIST PUSH cache:$k BACK $v0, $v1;',
      ['k', 'v0', 'v1'],
    ],
    [s.listPush('k', texts('a'), true), 'LIST PUSH cache:$k FRONT $v0;', ['k', 'v0']],
    [s.listPop('k', true), 'LIST POP cache:$k FRONT;', ['k']],
    [s.listPop('k', false, 3), 'LIST POP cache:$k BACK LIMIT $n;', ['k', 'n']],
    [
      s.listRange('k', 0, 10),
      'RETURN array::slice(GET cache:$k, $i, $n);',
      ['k', 'i', 'n'],
    ],
    [s.listAt('k', -1), 'RETURN array::at(GET cache:$k, $i);', ['k', 'i']],
    [s.listLen('k'), 'RETURN array::len(GET cache:$k);', ['k']],
    [s.listRemove('k', str('a')), 'LIST REMOVE cache:$k $v;', ['k', 'v']],
    [
      s.listRemove('k', str('a'), 2),
      'LIST REMOVE cache:$k $v LIMIT $n;',
      ['k', 'v', 'n'],
    ],
    [s.listTrim('k', 0, 99), 'LIST TRIM cache:$k FROM $i TO $j;', ['k', 'i', 'j']],
    [
      s.hashSet(
        'k',
        new Map<string, Value>([
          ['x', { kind: 'integer', value: 1n }],
          ['y', { kind: 'null' }],
        ]),
      ),
      'HASH SET cache:$k $f0 = $v0, $f1 = $v1;',
      ['k', 'f0', 'v0', 'f1', 'v1'],
    ],
    [s.hashGet('k', 'x'), 'RETURN object::get(GET cache:$k, $f);', ['k', 'f']],
    [
      s.hashRemove('k', ['x', 'y']),
      'HASH REMOVE cache:$k $f0, $f1;',
      ['k', 'f0', 'f1'],
    ],
    [s.hashIncr('k', 'x', 2n), 'HASH INCR cache:$k $f BY $n;', ['k', 'f', 'n']],
    [s.hashLen('k'), 'RETURN object::len(GET cache:$k);', ['k']],
    [
      s.members('ADD', 'k', texts('a', 'b')),
      'MEMBERS ADD cache:$k $v0, $v1;',
      ['k', 'v0', 'v1'],
    ],
    [s.members('REMOVE', 'k', texts('a')), 'MEMBERS REMOVE cache:$k $v0;', ['k', 'v0']],
    [s.membersHas('k', str('a')), 'RETURN $v IN GET cache:$k;', ['k', 'v']],
    [s.membersLen('k'), 'RETURN set::len(GET cache:$k);', ['k']],
    [
      s.scoresAdd(
        'k',
        new Map([
          ['ann', 1],
          ['bob', 2.5],
        ]),
      ),
      'SCORES ADD cache:$k $m0 = $c0, $m1 = $c1;',
      ['k', 'm0', 'c0', 'm1', 'c1'],
    ],
    [s.scoresIncr('k', 'ann', 1.5), 'SCORES INCR cache:$k $m BY $c;', ['k', 'm', 'c']],
    [s.scoresRemove('k', ['ann']), 'SCORES REMOVE cache:$k $m0;', ['k', 'm0']],
    [
      s.scoresOf('score', 'k', 'ann'),
      'RETURN scores::score(GET cache:$k, $m);',
      ['k', 'm'],
    ],
    [
      s.scoresOf('rank', 'k', 'ann'),
      'RETURN scores::rank(GET cache:$k, $m);',
      ['k', 'm'],
    ],
    [
      s.scoresRange('k', 0, -1),
      'RETURN scores::range(GET cache:$k, $i, $j);',
      ['k', 'i', 'j'],
    ],
    [
      s.scoresBetween('k', 1, 2),
      'RETURN scores::between(GET cache:$k, $lo, $hi);',
      ['k', 'lo', 'hi'],
    ],
    [
      s.scoresBetween('k', undefined, 2),
      'RETURN scores::between(GET cache:$k, NONE, $hi);',
      ['k', 'hi'],
    ],
    [
      s.scoresBetween('k', 1),
      'RETURN scores::between(GET cache:$k, $lo, NONE);',
      ['k', 'lo'],
    ],
  ];
  for (const [[script, given], statement, bound] of cases) {
    assert.equal(script, USE + statement);
    assert.deepEqual([...given.keys()], bound, statement);
  }
});

const target = process.env['TESSARIDB_TEST_NODE'];
const runs = target ? test : test.skip;

async function cache(t: TestContext): Promise<Cache> {
  const [host, port] = (target ?? '').split(':');
  const connection = await connect({
    host: host ?? '127.0.0.1',
    port: Number(port ?? 0),
  });
  t.after(() => connection.close());
  const space = `box_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await connection.execute(
    'DEFINE NAMESPACE IF NOT EXISTS jscache; USE NAMESPACE jscache; ' +
      `DEFINE DATABASE IF NOT EXISTS app; USE DATABASE app; DEFINE SPACE ${space};`,
  );
  return new Cache(connection, { namespace: 'jscache', database: 'app', space });
}

runs('a key holds a list, a hash, a set and a ranking', async (t) => {
  const c = await cache(t);
  assert.equal(await c.listPush('l', texts('a', 'b', 'c', 'd')), 4);
  assert.equal(await c.listLen('l'), 4);
  assert.deepEqual(await c.listAt('l', -1), str('d'));
  assert.deepEqual(await c.listRange('l', 1, 2), texts('b', 'c'));
  assert.deepEqual(await c.listPop('l'), str('a'));
  assert.deepEqual(await c.listPopMany('l', 2, { front: false }), texts('d', 'c'));
  assert.equal(await c.listRemove('l', str('b')), 1);
  assert.equal(await c.listLen('l'), 0, 'an emptied list is no key');
  assert.deepEqual(await c.listRange('nothing', 0, 5), []);
  await c.listPush('t', texts('1', '2', '3'));
  await c.listTrim('t', 0, 1);
  assert.equal(await c.listLen('t'), 2);

  const fields = new Map<string, Value>([
    ['x', { kind: 'integer', value: 1n }],
    ['y', str('why')],
  ]);
  assert.equal(await c.hashSet('h', fields), 2);
  assert.deepEqual(await c.hashGet('h', 'y'), str('why'));
  assert.equal(await c.hashGet('h', 'z'), undefined);
  assert.equal(await c.hashIncr('h', 'x', 4n), 5n);
  assert.equal(await c.hashLen('h'), 2);
  assert.equal(await c.hashRemove('h', ['y']), 1);
  assert.deepEqual([...(await c.hashGetAll('h')).keys()], ['x']);
  assert.equal((await c.hashGetAll('nothing')).size, 0);

  assert.equal(await c.membersAdd('s', texts('p', 'q')), 2);
  assert.equal(await c.membersHas('s', str('p')), true);
  assert.equal(await c.membersHas('nothing', str('p')), false);
  assert.equal(await c.membersLen('s'), 2);
  assert.equal(await c.membersRemove('s', texts('q')), 1);
  assert.deepEqual(await c.membersAll('s'), texts('p'));

  assert.equal(
    await c.scoresAdd(
      'r',
      new Map([
        ['ann', 3],
        ['bob', 1],
        ['cid', 2],
      ]),
    ),
    3,
  );
  assert.equal(await c.scoresIncr('r', 'bob', 0.5), 1.5);
  assert.equal(await c.scoresScore('r', 'ann'), 3);
  assert.equal(await c.scoresRank('r', 'ann'), 2);
  assert.equal(await c.scoresRank('r', 'eve'), undefined);
  assert.deepEqual(await c.scoresRange('r', 0, 1), [
    ['bob', 1.5],
    ['cid', 2],
  ]);
  assert.deepEqual(await c.scoresBetween('r', { low: 2 }), [
    ['cid', 2],
    ['ann', 3],
  ]);
  assert.equal(await c.scoresRemove('r', ['ann']), 1);

  await assert.rejects(c.listPush('l', []), ContainerArgumentError);
  await assert.rejects(c.listRange('l', -1, 2), ContainerArgumentError);
});
