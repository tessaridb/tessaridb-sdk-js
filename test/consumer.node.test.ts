/**
 * The topic consumer against a running node (consumer contract §7).
 *
 *   TESSARIDB_TEST_NODE=127.0.0.1:47915 npm test
 *
 * The waits are real: a group's deadline is an instant the NODE compares with
 * its own clock.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { connect, Consumer, ConsumerNameError } from '../src/index.ts';
import type { Message, Value } from '../src/index.ts';

const target = process.env['TESSARIDB_TEST_NODE'];
const runs = target ? test : test.skip;

/**
 * `TESSARIDB_TEST_TRANSPORT=websocket` runs the same tests over `GET /wire`, with
 * `TESSARIDB_TEST_NODE` naming the node's HTTP port instead of its wire port.
 */
function address(): { host: string; port: number; transport: 'tcp' | 'websocket' } {
  const [host, port] = (target ?? '').split(':');
  const transport =
    process.env['TESSARIDB_TEST_TRANSPORT'] === 'websocket' ? 'websocket' : 'tcp';
  return { host: host ?? '127.0.0.1', port: Number(port ?? 0), transport };
}

const USE = 'USE NAMESPACE jsconsumer; USE DATABASE app;';

/** A fresh topic per run, so a rerun never meets the last run's messages or group. */
async function topic(stem: string, count: number, deadline: string): Promise<string> {
  const name = `${stem}_${process.hrtime.bigint()}`;
  const connection = await connect(address());
  try {
    await connection.execute(
      'DEFINE NAMESPACE IF NOT EXISTS jsconsumer; USE NAMESPACE jsconsumer; ' +
        `DEFINE DATABASE IF NOT EXISTS app; USE DATABASE app; DEFINE TOPIC ${name};`,
    );
    const creates = Array.from(
      { length: count },
      (_, index) => `CREATE ${name}:'m${index + 1}' = { n: ${index + 1} };`,
    ).join(' ');
    await connection.execute(
      `${USE} ${creates} DEFINE GROUP 'workers' ON TOPIC ${name} ACK DEADLINE ${deadline};`,
    );
  } finally {
    connection.close();
  }
  return name;
}

function nOf(message: Message): bigint {
  const value = message.value;
  assert.equal(value.kind, 'object');
  const n = (value as Extract<Value, { kind: 'object' }>).fields.get('n');
  assert.equal(n?.kind, 'integer');
  return (n as Extract<Value, { kind: 'integer' }>).value;
}

runs(
  'auto hands every message to the handler in order and leaves nothing in flight',
  async () => {
    const name = await topic('auto_jobs', 12, '30s');
    const connection = await connect(address());
    try {
      const consumer = new Consumer(connection, {
        namespace: 'jsconsumer',
        database: 'app',
        topic: name,
        group: 'workers',
        batch: 5,
      });
      const seen: bigint[] = [];
      await consumer.runAuto((message) => {
        seen.push(nOf(message));
        if (seen.length === 12) consumer.stop();
      });
      assert.deepEqual(
        seen,
        Array.from({ length: 12 }, (_, index) => BigInt(index + 1)),
      );
      const reply = await connection.execute(`${USE} INFO FOR TOPIC ${name};`);
      assert.equal(reply.kind, 'answer');
      const report = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
      assert.equal(report?.kind, 'value');
      const value = (report as { value: Value }).value;
      const groups = (value as Extract<Value, { kind: 'object' }>).fields.get('groups');
      const workers = (groups as Extract<Value, { kind: 'object' }>).fields.get(
        'workers',
      );
      assert.deepEqual(
        (workers as Extract<Value, { kind: 'object' }>).fields.get('in_flight'),
        {
          kind: 'integer',
          value: 0n,
        },
      );
    } finally {
      connection.close();
    }
  },
);

runs('a failing handler sees the same message again one delivery later', async () => {
  const name = await topic('flaky_jobs', 2, '30s');
  const connection = await connect(address());
  try {
    const consumer = new Consumer(connection, {
      namespace: 'jsconsumer',
      database: 'app',
      topic: name,
      group: 'workers',
    });
    const seen: [bigint, bigint][] = [];
    await consumer.runAuto((message) => {
      seen.push([message.position, message.deliveries]);
      if (seen.length === 3) consumer.stop();
      if (message.position === 1n && message.deliveries === 1n) {
        throw new Error('the first delivery fails once');
      }
    });
    assert.deepEqual(seen, [
      [1n, 1n],
      [1n, 2n],
      [2n, 1n],
    ]);
  } finally {
    connection.close();
  }
});

runs(
  'manual leaves a message and the group hands it out again after the deadline',
  async () => {
    const name = await topic('left_jobs', 1, '300ms');
    const connection = await connect(address());
    try {
      const consumer = new Consumer(connection, {
        namespace: 'jsconsumer',
        database: 'app',
        topic: name,
        group: 'workers',
      });
      const seen: bigint[] = [];
      const watchdog = setTimeout(() => consumer.stop(), 10_000);
      await consumer.runManual((message) => {
        seen.push(message.deliveries);
        if (message.deliveries === 1n) return { kind: 'leave' };
        consumer.stop();
        return { kind: 'ack' };
      });
      clearTimeout(watchdog);
      assert.deepEqual(seen, [1n, 2n]);
    } finally {
      connection.close();
    }
  },
);

test('names that cannot be written into a statement are refused before sending', () => {
  const nobody = undefined as unknown as Parameters<typeof Consumer.prototype.ack>[0] &
    ConstructorParameters<typeof Consumer>[0];
  assert.throws(
    () =>
      new Consumer(nobody, {
        namespace: 'jsconsumer',
        database: 'app',
        topic: 'jobs; DROP',
        group: 'workers',
      }),
    ConsumerNameError,
  );
  assert.throws(
    () =>
      new Consumer(nobody, {
        namespace: 'jsconsumer',
        database: 'app',
        topic: 'jobs',
        group: "it's",
      }),
    ConsumerNameError,
  );
});
