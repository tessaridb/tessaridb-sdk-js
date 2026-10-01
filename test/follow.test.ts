import { strict as assert } from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { after, test } from 'node:test';
import { ByteReader, ByteWriter } from '../src/codec/bytes.ts';
import { encodeValue } from '../src/codec/encode.ts';
import { connect } from '../src/connect.ts';
import type { Connection } from '../src/connection.ts';
import {
  NotFollowableError,
  RedirectLoopError,
  StaleRedirectError,
  WrongNodeError,
} from '../src/error.ts';
import type { Value } from '../src/value.ts';

/*
 * Following a redirect (protocol §3.12), against scripted nodes on loopback.
 * Each fake greets, keeps its own session's `USE`, answers
 * `session::context()` as a node does, and hands every other script to the
 * test's function.
 */

const A = new Uint8Array(16).fill(0xa);
const B = new Uint8Array(16).fill(0xb);
const C = new Uint8Array(16).fill(0xc);
const READ = 'SELECT * FROM ledger;';
const CONTEXT = 'RETURN session::context();';

interface Go {
  go: { node: Uint8Array; epoch: bigint; settled: boolean; endpoint: string };
}
type Reply = Value | Go;
type Behaviour = (script: string) => Reply;

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

class Fake {
  readonly seen: string[] = [];
  readonly signed: string[] = [];
  port = 0;
  readonly node: Uint8Array;
  readonly #behave: Behaviour;
  readonly #claims: Uint8Array;

  constructor(node: Uint8Array, behave: Behaviour, claims: Uint8Array = node) {
    this.node = node;
    this.#behave = behave;
    this.#claims = claims;
  }

  get address(): string {
    return `127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    const server = createServer((socket) => this.#serve(socket));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    if (bound === null || typeof bound === 'string') throw new Error('no port');
    this.port = bound.port;
    return this;
  }

  #serve(socket: Socket): void {
    let held = Buffer.alloc(0);
    let greeted = false;
    let namespace: Value = { kind: 'null' };
    let database: Value = { kind: 'null' };
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      held = Buffer.concat([held, chunk]);
      if (!greeted) {
        if (held.length < 6) return;
        held = held.subarray(6);
        greeted = true;
        socket.write(Uint8Array.from([0x54, 0x45, 0x53, 0x53, 1, 2]));
      }
      while (held.length >= 5) {
        const length = held.readUInt32BE(1);
        if (held.length < 5 + length) return;
        const r = new ByteReader(new Uint8Array(held.subarray(5, 5 + length)));
        held = held.subarray(5 + length);
        const script = r.text();
        if (r.u8() === 1) this.signed.push(r.text());
        this.seen.push(script);
        let reply: Reply;
        if (script === CONTEXT) {
          reply = {
            kind: 'object',
            fields: new Map<string, Value>([
              ['node', { kind: 'uuid', value: this.#claims }],
              ['namespace', namespace],
              ['database', database],
            ]),
          };
        } else if (script.startsWith('USE ')) {
          for (const statement of script.split(';')) {
            const [use, what, name] = statement.trim().split(/\s+/);
            if (use === 'USE' && what === 'NAMESPACE' && name)
              namespace = { kind: 'string', value: name };
            if (use === 'USE' && what === 'DATABASE' && name)
              database = { kind: 'string', value: name };
          }
          reply = { kind: 'null' };
        } else {
          reply = this.#behave(script);
        }
        socket.write(frameOf(reply));
      }
    });
  }
}

function frameOf(reply: Reply): Uint8Array {
  const body = new ByteWriter();
  let kind: number;
  if ('go' in reply) {
    kind = 13;
    body.fixed(reply.go.node);
    body.u64(reply.go.epoch);
    body.u8(reply.go.settled ? 1 : 2);
    body.text(reply.go.endpoint);
  } else {
    kind = 2;
    const outcome = new ByteWriter();
    outcome.u8(2);
    outcome.u32(0);
    outcome.lenbytes(encodeValue(reply));
    const encoded = outcome.finish();
    body.u32(1);
    body.lenbytes(encoded);
  }
  const bytes = body.finish();
  const frame = new ByteWriter();
  frame.u8(kind);
  frame.u32(bytes.length);
  frame.fixed(bytes);
  return frame.finish();
}

const integer = (value: bigint): Value => ({ kind: 'integer', value });
const answers =
  (n: bigint): Behaviour =>
  () =>
    integer(n);

/** READ goes to `to`; anything else is answered here. */
function sends(to: Fake, epoch: bigint, settled: boolean): Behaviour {
  return (script) =>
    script === READ
      ? { go: { node: to.node, epoch, settled, endpoint: to.address } }
      : integer(1n);
}

async function selected(origin: Fake): Promise<Connection> {
  const conn = await connect({
    host: '127.0.0.1',
    port: origin.port,
    user: 'ada',
    password: 'secret',
  });
  await conn.execute('USE NAMESPACE prod; USE DATABASE shop;');
  return conn;
}

test('a transient redirect answers there and leaves the connection here', async () => {
  const b = await new Fake(B, answers(42n)).start();
  const a = await new Fake(A, sends(b, 7n, false)).start();
  const conn = await selected(a);
  const reply = await conn.execute(READ);
  assert.equal(reply.kind, 'answer');
  const last = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
  assert.deepEqual(last?.kind === 'value' ? last.value : undefined, integer(42n));
  assert.deepEqual(b.seen, [CONTEXT, 'USE NAMESPACE prod; USE DATABASE shop; ', READ]);
  assert.equal(b.signed[0], 'ada', 'the credentials were presented there');
  await conn.execute('RETURN 1;');
  assert.equal(a.seen.at(-1), 'RETURN 1;');
  assert.equal(b.seen.length, 3, 'B was not asked again');
  conn.close();
});

test('a settled redirect moves the connection there', async () => {
  const b = await new Fake(B, answers(42n)).start();
  const a = await new Fake(A, sends(b, 7n, true)).start();
  const conn = await selected(a);
  await conn.execute(READ);
  await conn.execute('RETURN 1;');
  assert.equal(b.seen.at(-1), 'RETURN 1;');
  assert.ok(!a.seen.includes('RETURN 1;'), 'A was left');
  conn.close();
});

test('a node other than the one named is not sent the request', async () => {
  const b = await new Fake(B, answers(42n), C).start();
  const a = await new Fake(A, sends(b, 7n, false)).start();
  const conn = await selected(a);
  await assert.rejects(conn.execute(READ), (error: unknown) => {
    assert.ok(error instanceof WrongNodeError);
    assert.deepEqual(error.expected, B);
    return true;
  });
  assert.ok(!b.seen.includes(READ));
  conn.close();
});

test('a redirect dated before one already followed is refused', async () => {
  const c = await new Fake(C, answers(42n)).start();
  const b = await new Fake(B, sends(c, 3n, false)).start();
  const a = await new Fake(A, sends(b, 5n, false)).start();
  const conn = await selected(a);
  await assert.rejects(conn.execute(READ), (error: unknown) => {
    assert.ok(error instanceof StaleRedirectError);
    assert.deepEqual([error.epoch, error.floor], [3n, 5n]);
    return true;
  });
  assert.deepEqual(c.seen, [], 'C was never dialled');
  conn.close();
});

test('three hops and no answer is a loop', async () => {
  const c: Fake = new Fake(C, () => ({
    go: { node: C, epoch: 1n, settled: false, endpoint: c.address },
  }));
  await c.start();
  const a = await new Fake(A, sends(c, 1n, false)).start();
  const conn = await selected(a);
  await assert.rejects(conn.execute(READ), (error: unknown) => {
    assert.ok(error instanceof RedirectLoopError);
    assert.equal(error.hops, 3);
    return true;
  });
  assert.equal(c.seen.filter((script) => script === READ).length, 3);
  conn.close();
});

test('a tenancy that is not a plain name is not followed', async () => {
  const b = await new Fake(B, answers(42n)).start();
  const a = await new Fake(A, sends(b, 7n, false)).start();
  const conn = await connect({ host: '127.0.0.1', port: a.port });
  await conn.execute('USE NAMESPACE pr-od;');
  await assert.rejects(conn.execute(READ), (error: unknown) => {
    assert.ok(error instanceof NotFollowableError);
    assert.equal(error.selected, 'pr-od');
    return true;
  });
  assert.deepEqual(b.seen, [], 'B was never dialled');
  conn.close();
});

/*
 * The live half: a write and a leader-only read sent to a follower of a real
 * two-node cluster land on the leader, the read by a transient redirect this
 * client follows. `TESSARIDB_TEST_CLUSTER=<leader host:port>,<follower
 * host:port>`, a cluster whose namespace `prod` holds database `shop` with
 * collection `ledger`.
 */
const cluster = process.env['TESSARIDB_TEST_CLUSTER'];

test(
  'a misrouted write and read land on the leader of a live cluster',
  { skip: cluster === undefined ? 'TESSARIDB_TEST_CLUSTER is not set' : false },
  async () => {
    const [leader, follower] = (cluster ?? '').split(',');
    const at = (address: string | undefined) => {
      const [host, port] = (address ?? '').split(':');
      return connect({ host: host ?? '', port: Number(port) });
    };
    const tenancy = 'USE NAMESPACE prod; USE DATABASE shop;';
    const key = `js${process.pid}`;
    const nodeOf = async (conn: Connection): Promise<Value | undefined> => {
      const reply = await conn.execute(CONTEXT);
      const last = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
      return last?.kind === 'value' && last.value.kind === 'object'
        ? last.value.fields.get('node')
        : undefined;
    };
    const rows = (reply: Awaited<ReturnType<Connection['execute']>>): number => {
      const last = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
      return last?.kind === 'records' ? last.records.length : -1;
    };

    // A forward carries the script and not the session.
    const writer = await at(follower);
    await writer.execute(`${tenancy} CREATE ledger:'${key}' = { total: 1 };`);
    writer.close();
    const onLeader = await at(leader);
    const leaderNode = await nodeOf(onLeader);
    await onLeader.execute(tenancy);
    assert.equal(rows(await onLeader.execute(`SELECT * FROM ledger:'${key}';`)), 1);
    onLeader.close();

    const reader = await at(follower);
    const followerNode = await nodeOf(reader);
    assert.notDeepEqual(leaderNode, followerNode);
    await reader.execute(tenancy);
    const reply = await reader.execute(
      `SELECT * FROM ledger:'${key}' ANSWERED BY LEADER;`,
    );
    assert.equal(reply.kind, 'answer', 'the redirect was followed');
    assert.equal(rows(reply), 1, 'the leader answered');
    assert.deepEqual(
      await nodeOf(reader),
      followerNode,
      'a transient redirect stays here',
    );
    reader.close();
  },
);
