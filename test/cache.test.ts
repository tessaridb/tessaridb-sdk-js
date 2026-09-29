import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  Cache,
  CacheArgumentError,
  CacheStatements,
  Lease,
  connect,
} from '../src/index.ts';
import type { Value } from '../src/index.ts';
import { duration, unquoted } from '../src/cache.ts';

/**
 * The cache handle's statements, byte for byte, as cache contract §2 writes
 * them, and — with `TESSARIDB_TEST_NODE` set — every call against a running node
 * (§6), over TCP or, with `TESSARIDB_TEST_TRANSPORT=websocket`, over `/wire`.
 */
const USE = 'USE NAMESPACE app; USE DATABASE main; ';
const NULL: Value = { kind: 'null' };

test('every statement is the one the contract writes', () => {
  const s = new CacheStatements('app', 'main', 'cache');
  const ttl = duration(30_000);
  const cases: [[string, Map<string, Value>], string, string[]][] = [
    [s.get('k'), 'GET cache:$k;', ['k']],
    [s.set('k', NULL), 'SET cache:$k = $v;', ['k', 'v']],
    [
      s.set('k', NULL, '', undefined, ttl),
      'SET cache:$k = $v EXPIRE $t;',
      ['k', 'v', 't'],
    ],
    [
      s.set('k', NULL, ' IF ABSENT', undefined, ttl),
      'SET cache:$k = $v IF ABSENT EXPIRE $t;',
      ['k', 'v', 't'],
    ],
    [s.set('k', NULL, ' IF PRESENT'), 'SET cache:$k = $v IF PRESENT;', ['k', 'v']],
    [s.set('k', NULL, ' IF = $e', NULL), 'SET cache:$k = $v IF = $e;', ['k', 'v', 'e']],
    [s.delete('k'), 'DELETE cache:$k RETURN BEFORE;', ['k']],
    [s.incr('k', 5n), 'INCR cache:$k BY $n;', ['k', 'n']],
    [s.ttl('k'), 'RETURN TTL cache:$k;', ['k']],
    [s.expire('k', ttl), 'EXPIRE cache:$k $t;', ['k', 't']],
    [s.persist('k'), 'PERSIST cache:$k;', ['k']],
    [s.keys(undefined, undefined, 100), 'KEYS FROM cache LIMIT 100;', []],
    [s.keys('', undefined, 100), 'KEYS FROM cache LIMIT 100;', []],
    [
      s.keys('user:', 'user:1', 10),
      'KEYS FROM cache PREFIX $p AFTER $a LIMIT 10;',
      ['p', 'a'],
    ],
    [s.lock('k', 'w1', ttl), 'SET cache:$k = $h IF ABSENT EXPIRE $t;', ['k', 'h', 't']],
    [s.extend('k', 'w1', ttl), 'SET cache:$k = $h IF = $h EXPIRE $t;', ['k', 'h', 't']],
    [s.release('k', 'w1'), "SET cache:$k = 'free' IF = $h EXPIRE 1ms;", ['k', 'h']],
  ];
  for (const [[script, given], statement, bound] of cases) {
    assert.equal(script, USE + statement);
    assert.deepEqual([...given.keys()], bound, statement);
  }
});

test('a name that is not one is refused before anything is rendered', () => {
  assert.throws(() => new CacheStatements('app', 'main', 'ca-che'), CacheArgumentError);
});

test('a ttl is positive and exact', () => {
  assert.deepEqual(duration(1500), {
    kind: 'duration',
    seconds: 1n,
    nanos: 500_000_000,
  });
  for (const bad of [0, -1, Number.NaN]) {
    assert.throws(() => duration(bad), CacheArgumentError);
  }
});

test('a quoted key is the string again, and any other kind is left alone', () => {
  assert.equal(unquoted("'user:1'"), 'user:1');
  assert.equal(unquoted("'it\\'s'"), "it's");
  assert.equal(unquoted("'a\\\\b'"), 'a\\b');
  assert.equal(unquoted('42'), '42');
});

const target = process.env['TESSARIDB_TEST_NODE'];
const runs = target ? test : test.skip;

/** A fresh space; its connection is closed when `t` ends, or the process would not exit. */
async function cache(t: TestContext): Promise<Cache> {
  const [host, port] = (target ?? '').split(':');
  const transport =
    process.env['TESSARIDB_TEST_TRANSPORT'] === 'websocket' ? 'websocket' : 'tcp';
  const connection = await connect({
    host: host ?? '127.0.0.1',
    port: Number(port ?? 0),
    transport,
  });
  t.after(() => connection.close());
  const space = `cache_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await connection.execute(
    'DEFINE NAMESPACE IF NOT EXISTS jscache; USE NAMESPACE jscache; ' +
      `DEFINE DATABASE IF NOT EXISTS app; USE DATABASE app; DEFINE SPACE ${space};`,
  );
  return new Cache(connection, { namespace: 'jscache', database: 'app', space });
}

const int = (value: bigint): Value => ({ kind: 'integer', value });

runs('a value is stored, read, counted, expired and deleted', async (t) => {
  const c = await cache(t);
  const at: Value = { kind: 'datetime', seconds: 1_790_000_000n, nanos: 5 };
  await c.set('user:42', at, { ttlMs: 30_000 });
  assert.deepEqual(await c.get('user:42'), at);
  assert.equal((await c.ttl('user:42')).kind, 'expires');
  await c.set('user:42', int(1n));
  assert.deepEqual(
    await c.ttl('user:42'),
    { kind: 'never' },
    'a plain set kept the expiry',
  );
  assert.equal(await c.expire('user:42', 60_000), true);
  assert.equal(await c.persist('user:42'), true);
  assert.deepEqual(await c.ttl('nobody'), { kind: 'absent' });
  assert.equal(await c.incr('hits', 5n), 5n);
  assert.equal(await c.incr('hits'), 6n);
  assert.equal(await c.setIfAbsent('once', int(1n)), true);
  assert.equal(await c.setIfAbsent('once', int(2n)), false);
  assert.equal(await c.setIfPresent('never', int(1n)), false);
  assert.equal(await c.compareAndSet('once', int(9n), int(3n)), false);
  assert.equal(await c.compareAndSet('once', int(1n), int(3n)), true);
  await c.set("it's\\here", NULL);
  assert.deepEqual(await c.keys({ prefix: 'it' }), ["it's\\here"]);
  assert.deepEqual(await c.keys({ after: "it's\\here", limit: 1 }), ['once']);
  assert.equal(await c.delete("it's\\here"), true, 'a key holding NULL is a key');
  assert.equal(await c.delete("it's\\here"), false);
  assert.equal(await c.get("it's\\here"), undefined);
  await assert.rejects(c.keys({ limit: 0 }), CacheArgumentError);
});

runs('getOrSet loads once and then answers what is stored', async (t) => {
  const c = await cache(t);
  const first = await c.getOrSet('page', 30_000, () => ({
    kind: 'string',
    value: 'rendered',
  }));
  const second = await c.getOrSet('page', 30_000, () => ({
    kind: 'string',
    value: 'again',
  }));
  assert.deepEqual(
    [first, second],
    [
      { kind: 'string', value: 'rendered' },
      { kind: 'string', value: 'rendered' },
    ],
  );
  assert.equal((await c.ttl('page')).kind, 'expires', 'stored without its ttl');
});

runs(
  'a lease is extended by its holder and released so the next can take it',
  async (t) => {
    const c = await cache(t);
    const lease = await c.lock('report', 30_000);
    assert.ok(lease, 'a free lock');
    assert.equal(lease.holder.length, 32);
    assert.equal(
      await c.lock('report', 30_000, 'other'),
      undefined,
      'a held lock was taken',
    );
    assert.equal(await lease.extend(), true, 'its holder could not extend it');
    assert.equal(
      await c.releaseLease({ key: 'report', holder: 'other' } as never),
      false,
    );
    assert.equal(await lease.release(), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      await c.lock('report', 30_000, 'next'),
      'a released lock could not be taken again, so the release left it permanent',
    );
    assert.deepEqual(await c.get('report'), { kind: 'string', value: 'next' });
  },
);
