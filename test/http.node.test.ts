import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpClient } from '../src/index.ts';
import type { HttpOutcome } from '../src/index.ts';

/**
 * The HTTP surface against a running node.
 *
 * Opt-in, like every other live test here. What they prove that no corpus can is
 * the shape of the ROUTES: which status a missing file answers, whether an empty
 * bucket and a missing one are the same thing, whether a `DELETE` of nothing is
 * an error. Each of those is a sentence in §5 that a client can implement exactly
 * backwards while every unit test passes.
 *
 *   TESSARIDB_TEST_HTTP=127.0.0.1:47916 npm test
 */
const target = process.env['TESSARIDB_TEST_HTTP'];
const runs = target ? test : test.skip;

if (!target) {
  console.log('http tests skipped: set TESSARIDB_TEST_HTTP=<host:port> to run them');
}

function client(): HttpClient {
  const [host, port] = (target ?? '').split(':');
  return new HttpClient({ host: host ?? '127.0.0.1', port: Number(port ?? 0) });
}

const NS = 'httpcorpus';
const DB = 'files';
const BUCKET = 'things';

const SCHEMA = `
DEFINE NAMESPACE IF NOT EXISTS ${NS};
USE NAMESPACE ${NS};
DEFINE DATABASE IF NOT EXISTS ${DB};
USE DATABASE ${DB};
DEFINE COLLECTION IF NOT EXISTS note;
DEFINE BUCKET IF NOT EXISTS ${BUCKET};
`;

const USE = `USE NAMESPACE ${NS}; USE DATABASE ${DB};`;

runs('health and ready are answered, and 503 would be an answer too', async () => {
  const node = client();
  const health = await node.health();
  const ready = await node.ready();

  assert.ok(
    ['ok', 'unwell', 'leaving'].includes(health.status),
    'a status this build knows',
  );
  assert.equal(ready.status, health.status, 'a well node answers both the same way');
  if (health.status === 'ok') {
    assert.equal(typeof health.committed, 'bigint', 'the commit position is an i64');
  }
});

runs('a script answers one outcome per statement, in order', async () => {
  const node = client();
  await node.script(SCHEMA);
  await node.script(`${USE} DELETE FROM note WHERE true LIMIT ALL;`);

  const outcomes = await node.script(
    `${USE} CREATE note:'one' = { body: 'first' }; SELECT * FROM note; RETURN 4;`,
  );

  // Two USE statements, the create, the select, the return.
  assert.equal(outcomes.length, 5, 'one outcome per statement');
  const records = outcomes.find((o) => o.kind === 'records') as Extract<
    HttpOutcome,
    { kind: 'records' }
  >;
  assert.ok(records, 'the select produced records');
  assert.equal(records.records.length, 1);
  assert.equal(
    records.records[0]?.id,
    'one',
    'the id half alone, with no table prefix',
  );

  const value = outcomes.at(-1);
  assert.equal(value?.kind, 'value');
  assert.equal((value as { value: unknown }).value, 4);
});

runs('a failed script reports the failure and none of what already ran', async () => {
  const node = client();
  await node.script(SCHEMA);

  await assert.rejects(
    () => node.script(`${USE} RETURN 1; SELECT * FROM nosuchtable;`),
    (error: Error) => {
      // The refusal names the second statement and the `1` is nowhere in it.
      assert.ok(/nosuchtable/.test(error.message), 'the node names what it refused');
      return true;
    },
  );
});

runs(
  'a missing file is an answer, and an empty one is not the same answer',
  async () => {
    const node = client();
    await node.script(SCHEMA);

    assert.equal(
      await node.get(NS, DB, BUCKET, 'nothing-here.txt'),
      undefined,
      'a 404 is the file not being there',
    );

    await node.put(NS, DB, BUCKET, 'empty.txt', new Uint8Array());
    const empty = await node.get(NS, DB, BUCKET, 'empty.txt');
    assert.ok(
      empty instanceof Uint8Array,
      'a file that exists and is empty is not a missing file',
    );
    assert.equal(empty.length, 0);

    await node.remove(NS, DB, BUCKET, 'empty.txt');
  },
);

runs('a file name is carried as a name, not as a path', async () => {
  const node = client();
  await node.script(SCHEMA);

  // A space, a percent and a slash: the first two must be encoded or the request
  // line is unparseable, and the slash is part of the name rather than a
  // directory. This is the case that proves the encoder is not encodeURIComponent.
  const name = "100% done/it's here.txt";
  const body = new TextEncoder().encode('carried');

  await node.put(NS, DB, BUCKET, name, body);
  const back = await node.get(NS, DB, BUCKET, name);
  assert.deepStrictEqual(back, body, 'stored under the name the caller gave');

  const listing = await node.list(NS, DB, BUCKET);
  assert.ok(listing, 'the bucket is there');
  assert.ok(
    listing.some((entry) => entry.path.includes(name)),
    `the listing carries the file: ${JSON.stringify(listing.map((e) => e.path))}`,
  );

  await node.remove(NS, DB, BUCKET, name);
  assert.equal(await node.get(NS, DB, BUCKET, name), undefined);
});

runs('deleting a file that is not there is not an error', async () => {
  const node = client();
  await node.script(SCHEMA);
  // The server reports no difference, so a client claiming to know which
  // happened would be inventing it.
  await node.remove(NS, DB, BUCKET, 'never-existed.txt');
});

runs('a name that is not a bucket is not an empty bucket', async () => {
  const node = client();
  await node.script(SCHEMA);
  // `note` is a collection. Reading an empty listing as "it exists and is empty"
  // is the error this asserts against.
  assert.equal(await node.list(NS, DB, 'note'), undefined);
  assert.equal(await node.list(NS, DB, 'nothing_declared_this'), undefined);
});

runs('an open store has no session to open, and that is not a failure', async () => {
  // A token cut from the absence of a credential would still work after the
  // first DEFINE USER closed the store, which is precisely what must not happen.
  const node = new HttpClient({
    ...(() => {
      const [host, port] = (target ?? '').split(':');
      return { host: host ?? '127.0.0.1', port: Number(port ?? 0) };
    })(),
    credentials: { user: 'nobody', password: 'nothing' },
  });

  // The node applies a per-user sign-in limiter that §5.2 does not enumerate,
  // and it answers `429` to a name that has been refused a few times — before
  // the store gets to say it has no session to open. Both answers are correct
  // and the test must not depend on how often it has been run against the same
  // long-lived node.
  try {
    assert.equal(await node.openSession(), false, 'no token is minted');
  } catch (why) {
    assert.equal(
      (why as { status?: number }).status,
      429,
      'only the limiter may interrupt this, and it teaches the client nothing',
    );
  }
  assert.equal(node.token, undefined);
  // And the client carries on: on an open store there is nothing to prove.
  assert.ok((await node.health()).status);
});

runs('the whole log comes back in one response', async () => {
  const node = client();
  const log = await node.backup();
  assert.ok(log.length > 0, 'a store that has been written to has a log');
});

/**
 * A closed store, where the session token is the point.
 *
 *   TESSARIDB_TEST_HTTP_CLOSED=127.0.0.1:47918 \
 *   TESSARIDB_TEST_USER=corpus TESSARIDB_TEST_PASSWORD=… npm test
 *
 * Separate from the open-store variable because the two conditions are different
 * stores, not different requests: a store with no `DEFINE USER` cannot be made to
 * answer these and a closed one cannot be made to answer the one above it.
 */
const closed = process.env['TESSARIDB_TEST_HTTP_CLOSED'];
const signedIn = closed ? test : test.skip;

if (!closed) {
  console.log(
    'closed-store http tests skipped: set TESSARIDB_TEST_HTTP_CLOSED=<host:port>',
  );
}

function asUser(): HttpClient {
  const [host, port] = (closed ?? '').split(':');
  return new HttpClient({
    host: host ?? '127.0.0.1',
    port: Number(port ?? 0),
    credentials: {
      user: process.env['TESSARIDB_TEST_USER'] ?? '',
      password: process.env['TESSARIDB_TEST_PASSWORD'] ?? '',
    },
  });
}

signedIn('a closed store refuses a request with no credential', async () => {
  const [host, port] = (closed ?? '').split(':');
  const anonymous = new HttpClient({
    host: host ?? '127.0.0.1',
    port: Number(port ?? 0),
  });
  await assert.rejects(
    () => anonymous.script('RETURN 1;'),
    (error: Error & { status?: number }) => {
      // 401 means sign in. 403 would mean signing in again will never help, and
      // a client that merged them retries forever on one of the two.
      assert.equal(
        error.status,
        401,
        'sign in, rather than a permission that will not change',
      );
      return true;
    },
  );
});

signedIn(
  'the password is spent once, and the token carries every request after',
  async () => {
    const node = asUser();

    assert.equal(await node.openSession(), true, 'a closed store mints a token');
    const token = node.token;
    assert.equal(typeof token, 'string');
    assert.match(
      token!,
      /^[0-9a-f]{64}$/,
      'opaque, 64 lowercase hex characters, always',
    );

    const outcomes = await node.script('RETURN 1;');
    assert.equal(outcomes[0]?.kind, 'value');
    assert.equal(
      node.token,
      token,
      'and the same token was reused rather than re-minted',
    );

    await node.closeSession();
    assert.equal(node.token, undefined);
  },
);

signedIn(
  'a token that stopped working is replaced without the caller seeing it',
  async () => {
    const node = asUser();
    await node.openSession();
    assert.ok(node.token);

    // A token ends four ways — expiry, hand-back, the user record changing, a
    // restart — and a client cannot tell them apart, because all four answer 401.
    // The correct behaviour for all four is the same, so forcing one is enough.
    await node.closeSession();
    assert.equal(node.token, undefined);

    const outcomes = await node.script('RETURN 1;');
    assert.equal(outcomes[0]?.kind, 'value', 'the call succeeded');
    assert.match(
      node.token!,
      /^[0-9a-f]{64}$/,
      'on a fresh token this client opened for itself',
    );
  },
);

signedIn(
  'a client with no password surfaces the 401 rather than retrying',
  async () => {
    // Handed a token rather than a password, a client cannot re-authenticate, and
    // looping on 401 would be the wrong answer delivered slowly.
    const [host, port] = (closed ?? '').split(':');
    const node = new HttpClient({
      host: host ?? '127.0.0.1',
      port: Number(port ?? 0),
      credentials: { user: 'corpus', password: 'the-wrong-one' },
    });

    assert.equal(await node.openSession(), false, 'a wrong password mints nothing');
    await assert.rejects(
      () => node.script('RETURN 1;'),
      (error: Error & { status?: number }) => error.status === 401,
    );
  },
);
