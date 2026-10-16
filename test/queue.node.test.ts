/**
 * The queue worker against a running node (queue contract §7).
 *
 *   TESSARIDB_TEST_NODE=127.0.0.1:47915 npm test
 *
 * The one real wait is a release's NOT BEFORE, an instant the NODE compares
 * with its own clock.
 */
import { strict as assert } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { compare, connect, Queue } from '../src/index.ts';
import type { Connection, Job } from '../src/index.ts';

const target = process.env['TESSARIDB_TEST_NODE'];
const runs = target ? test : test.skip;

function address(): { host: string; port: number } {
  const [host, port] = (target ?? '').split(':');
  return { host: host ?? '127.0.0.1', port: Number(port ?? 0) };
}

const USE = 'USE NAMESPACE jsqueue; USE DATABASE app;';

/** A fresh queue per run, so a rerun never meets the last run's work. */
async function queue(stem: string, count: number, clauses: string): Promise<string> {
  const name = `${stem}_${process.hrtime.bigint()}`;
  const connection = await connect(address());
  try {
    await connection.execute(
      'DEFINE NAMESPACE IF NOT EXISTS jsqueue; USE NAMESPACE jsqueue; ' +
        `DEFINE DATABASE IF NOT EXISTS app; USE DATABASE app; DEFINE QUEUE ${name} ${clauses};`,
    );
    const creates = Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      return `CREATE ${name}:${n} = { n: ${n}, kind: '${n % 2 === 0 ? 'image' : 'video'}' };`;
    }).join(' ');
    await connection.execute(`${USE} ${creates}`);
  } finally {
    connection.close();
  }
  return name;
}

function nOf(job: Job): bigint {
  const held = job.value.kind === 'object' ? job.value.fields.get('n') : undefined;
  assert.equal(held?.kind, 'integer');
  return held?.kind === 'integer' ? held.value : -1n;
}

async function left(connection: Connection, name: string): Promise<number> {
  const reply = await connection.execute(`${USE} SELECT * FROM ${name};`);
  const answered = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
  assert.equal(answered?.kind, 'records');
  return answered?.kind === 'records' ? answered.records.length : -1;
}

function worker(connection: Connection, name: string, extra: object = {}): Queue {
  return new Queue(connection, {
    namespace: 'jsqueue',
    database: 'app',
    queue: name,
    worker: 'resizer',
    ...extra,
  });
}

runs('auto takes every record once and leaves the queue empty', async () => {
  const name = await queue('auto_jobs', 12, 'TIMEOUT 30s');
  const connection = await connect(address());
  try {
    const jobs = worker(connection, name, { batch: 5 });
    const seen: bigint[] = [];
    await jobs.runAuto((job) => {
      seen.push(nOf(job));
      if (seen.length === 12) jobs.stop();
    });
    assert.deepEqual(
      seen,
      Array.from({ length: 12 }, (_, index) => BigInt(index + 1)),
    );
    assert.equal(await left(connection, name), 0);
  } finally {
    connection.close();
  }
});

runs('a failing handler sees the same record again one attempt later', async () => {
  const name = await queue('flaky_jobs', 2, 'TIMEOUT 30s ATTEMPTS 3');
  const connection = await connect(address());
  try {
    const jobs = worker(connection, name);
    const seen: [bigint, bigint][] = [];
    await jobs.runAuto((job) => {
      seen.push([nOf(job), job.attempts]);
      if (seen.length === 3) jobs.stop();
      if (nOf(job) === 1n && job.attempts === 1n) throw new Error('fails once');
    });
    assert.deepEqual(seen, [
      [1n, 1n],
      [2n, 1n],
      [1n, 2n],
    ]);
  } finally {
    connection.close();
  }
});

runs('a condition takes only the records that match', async () => {
  const name = await queue('mixed_jobs', 6, 'TIMEOUT 30s');
  const connection = await connect(address());
  try {
    const jobs = worker(connection, name);
    const taken = await jobs.claim(
      10,
      compare('kind', 'eq', { kind: 'string', value: 'image' }),
    );
    assert.deepEqual(taken.map(nOf), [2n, 4n, 6n]);
    for (const job of taken) await jobs.done(job);
    assert.equal(await left(connection, name), 3);
  } finally {
    connection.close();
  }
});

runs('a release with a delay hands the record out only after it', async () => {
  const name = await queue('later_jobs', 1, 'TIMEOUT 30s NOT BEFORE due');
  const connection = await connect(address());
  try {
    const jobs = worker(connection, name);
    const [job] = await jobs.claim();
    assert.ok(job);
    await jobs.release(job, 400);
    assert.deepEqual(await jobs.claim(), [], 'handed out before its delay');
    await sleep(600);
    const again = await jobs.claim();
    assert.deepEqual(
      again.map((each) => [nOf(each), each.attempts]),
      [[1n, 2n]],
    );
  } finally {
    connection.close();
  }
});

runs('stop hands back what the handler never saw', async () => {
  const name = await queue('stopped_jobs', 3, 'TIMEOUT 30s');
  const connection = await connect(address());
  try {
    const jobs = worker(connection, name, { batch: 3 });
    await jobs.runManual(() => {
      jobs.stop();
      return { kind: 'leave' };
    });
    const other = new Queue(connection, {
      namespace: 'jsqueue',
      database: 'app',
      queue: name,
      worker: 'other',
    });
    assert.deepEqual((await other.claim(3)).map(nOf), [2n, 3n]);
  } finally {
    connection.close();
  }
});
