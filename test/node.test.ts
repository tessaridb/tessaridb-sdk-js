import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { connect, RefusalError } from '../src/index.ts';
import type { Outcome, Value } from '../src/index.ts';

/**
 * Exercised against a running node.
 *
 * These are opt-in, because a suite that needs a server cannot be the suite that
 * runs on a clean checkout. They are also the only tests here that prove
 * *semantics*: everything else proves the client agrees with the specification's
 * bytes, and a client can agree with the bytes and still ask the wrong question.
 *
 *   TESSARIDB_TEST_NODE=127.0.0.1:47915 npm test
 *
 * The suite seeds its own fixture and owns every record it asserts on. A test
 * that needs a node somebody set up by hand fails for the next person, and a test
 * that asserts on a table's total count fails as soon as any other test writes to
 * it — which is how this file failed the first time it ran.
 */
const target = process.env['TESSARIDB_TEST_NODE'];

function address(): { host: string; port: number } {
  const [host, port] = (target ?? '').split(':');
  return { host: host ?? '127.0.0.1', port: Number(port ?? 0) };
}

const live = test.skip;
const runs = target ? test : live;

if (!target) {
  console.log('node tests skipped: set TESSARIDB_TEST_NODE=<host:port> to run them');
}

function records(outcome: Outcome | undefined): Extract<Outcome, { kind: 'records' }> {
  assert.equal(outcome?.kind, 'records', 'expected a records outcome');
  return outcome as Extract<Outcome, { kind: 'records' }>;
}

const SCHEMA = `
DEFINE NAMESPACE IF NOT EXISTS demo;
USE NAMESPACE demo;
DEFINE DATABASE IF NOT EXISTS app;
USE DATABASE app;
DEFINE COLLECTION IF NOT EXISTS thing;
DEFINE COLLECTION IF NOT EXISTS watched;
`;

const FIXTURE = `
CREATE thing:1 = { name: 'alice', n: 42, at: datetime '2026-09-17T00:00:00Z',
  spot: geometry { type: 'Point', coordinates: [2.3522, 48.8566] } };
`;

const USE = 'USE NAMESPACE demo; USE DATABASE app;';

/**
 * Definitions, then an empty collection, then exactly one record.
 *
 * The emptying is the part that matters: these tests select by predicate as well
 * as by identity, so `thing` has to hold what this function put there and nothing
 * a previous run left behind. Deleting one record by id was not enough, and that
 * is how the suite failed against a store a broken run had already written to.
 *
 * `DELETE` takes an identity, so emptying a collection is `DELETE FROM … WHERE` —
 * and a delete over a set must state how much it may remove, hence `LIMIT ALL`.
 */
async function seeded(): Promise<Awaited<ReturnType<typeof connect>>> {
  const connection = await connect(address());
  await connection.execute(SCHEMA);
  await connection.execute('DELETE FROM thing WHERE true LIMIT ALL;');
  await connection.execute(FIXTURE);
  return connection;
}

runs(
  'the greeting is exchanged and a select round-trips with its types intact',
  async () => {
    const connection = await seeded();
    try {
      assert.equal(connection.peerMinor >= 0, true);

      // One record by identity, never a count over a table other tests also write to.
      const reply = await connection.execute(`${USE} SELECT * FROM thing:1;`);
      assert.equal(reply.kind, 'answer');
      if (reply.kind !== 'answer') return;

      assert.equal(reply.outcomes.length, 3, 'one outcome per statement, in order');
      const found = records(reply.outcomes[2]);
      assert.equal(found.records.length, 1);

      const value = found.records[0]!.value;
      assert.equal(value.kind, 'object');
      if (value.kind !== 'object') return;

      // An integer arrives as an i64, not as a double that happens to fit.
      assert.deepEqual(value.fields.get('n'), { kind: 'integer', value: 42n });
      assert.deepEqual(value.fields.get('name'), { kind: 'string', value: 'alice' });

      const at = value.fields.get('at');
      assert.equal(at?.kind, 'datetime', 'a datetime stays a datetime, not a string');

      // Longitude first, and the value is the one the store holds rather than one
      // that survived a decimal-string round trip.
      const spot = value.fields.get('spot');
      assert.equal(spot?.kind, 'geometry');
      if (spot?.kind !== 'geometry' || spot.shape.kind !== 'point') return;
      assert.equal(spot.shape.position.lon, 2.3522);
      assert.equal(spot.shape.position.lat, 48.8566);
    } finally {
      connection.close();
    }
  },
);

runs('a connection holds one session across statements', async () => {
  const connection = await seeded();
  try {
    // No USE here. If the session did not persist, this is a refusal.
    const reply = await connection.execute('SELECT * FROM thing:1;');
    assert.equal(reply.kind, 'answer');
    if (reply.kind !== 'answer') return;
    assert.equal(records(reply.outcomes[0]).records.length, 1);
  } finally {
    connection.close();
  }
});

runs('a parameter is bound as a value, never formatted into the script', async () => {
  const connection = await seeded();
  try {
    const reply = await connection.execute(
      'SELECT * FROM thing WHERE n = $n;',
      new Map([['n', { kind: 'integer', value: 42n } as const]]),
    );
    assert.equal(reply.kind, 'answer');
    if (reply.kind !== 'answer') return;
    assert.equal(
      records(reply.outcomes[0]).records.length,
      1,
      'the bound value matched',
    );
  } finally {
    connection.close();
  }
});

runs(
  'a refusal carries the store’s own words and does not close the connection',
  async () => {
    const connection = await connect(address());
    try {
      await assert.rejects(
        () => connection.execute('SELEKT * FROM nothing;'),
        RefusalError,
      );

      // Still a client. A mistyped statement has not ended the session.
      const reply = await connection.execute('USE NAMESPACE demo; USE DATABASE app;');
      assert.equal(reply.kind, 'answer');
    } finally {
      connection.close();
    }
  },
);

runs('a subscription delivers a change written by another connection', async () => {
  const identity = `run-${process.pid}-${Date.now()}`;
  let watcher: Awaited<ReturnType<typeof connect>> | undefined;
  let writer: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    watcher = await connect(address());
    writer = await seeded();
    // The watcher needs a database of its own: a subscription without a table
    // reads every table in *the session's* database, and a session that has not
    // chosen one is refused — which arrives as a Refusal frame, not a Change.
    await watcher.execute(USE);

    const changes = watcher!.changes({ table: 'watched', fromStart: true });
    await writer!.execute(`CREATE watched:'${identity}' = { n: 1 };`);

    // Look for the record this run wrote. `fromStart` replays the log, so the
    // first change delivered is an old one — asserting on it would pass or fail
    // depending on what the store already held.
    const deadline = Date.now() + 5000;
    let seen = false;
    while (!seen && Date.now() < deadline) {
      const next = await Promise.race([
        changes.next(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
      if (next === null || next.done) break;
      assert.equal(typeof next.value.sequence, 'bigint');
      assert.equal(next.value.table, 'watched', 'the table is named, not identified');
      if (next.value.identity.includes(identity)) seen = true;
    }
    assert.ok(seen, `the subscription never delivered watched:'${identity}'`);
  } finally {
    watcher?.close();
    writer?.close();
  }
});

runs('a value outcome carries a length before its value', async () => {
  // §3.5 writes this outcome as "names · `bytes` value", and `bytes` at the frame
  // layer is a u32 length then the bytes. Reading the value raw reads that
  // length's first byte as a type tag — `0x00`, which is not one.
  //
  // It fails loudly, and only for a client that ever asks for a value outcome.
  // This suite SELECTed and subscribed and never returned one, so the bug shipped
  // here and was found by the Go client against the same node.
  const connection = await connect(address());
  try {
    await connection.execute(SCHEMA);

    for (const [script, check] of [
      ['RETURN 1;', (v: Value) => v.kind === 'integer' && v.value === 1n],
      [`RETURN 'hello';`, (v: Value) => v.kind === 'string' && v.value === 'hello'],
      ['RETURN [1, 2];', (v: Value) => v.kind === 'array' && v.items.length === 2],
      ['RETURN NONE;', (v: Value) => v.kind === 'none'],
    ] as [string, (v: Value) => boolean][]) {
      const reply = await connection.execute(`${USE} ${script}`);
      assert.equal(reply.kind, 'answer');
      const outcome = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
      assert.equal(outcome?.kind, 'value', `${script}: a value outcome`);
      assert.ok(
        check((outcome as { value: Value }).value),
        `${script}: came back as ${JSON.stringify((outcome as { value: Value }).value, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))}`,
      );
    }
  } finally {
    await connection.close();
  }
});
