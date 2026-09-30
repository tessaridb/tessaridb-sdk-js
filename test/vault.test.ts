import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  RefusalError,
  Vault,
  VaultArgumentError,
  changePassphrase,
  connect,
  seal,
  unseal,
  vaultAudit,
} from '../src/index.ts';
import type { Connection, Value } from '../src/index.ts';
import { frameBody, readStatus } from '../src/vault/frame.ts';
import { VaultStatements, auditStatement } from '../src/vault/statements.ts';
import { bytesToHex, hexToBytes, readCorpus, valueOf } from './corpus.ts';

/**
 * The vault corpus (`vault-v1.json`) byte for byte, the status a node answers
 * with, and — with `TESSARIDB_TEST_NODE` set, against a node with an empty store —
 * the whole vault contract (§7), every error scanned for the passphrase.
 */
type Json = Record<string, unknown>;
const corpus = readCorpus('vault-v1.json') as {
  frames: { name: string; build: Json; body_hex: string }[];
  statements: {
    name: string;
    build: Json;
    script?: string;
    parameters?: Record<string, Json>;
    refused?: { reason: string; what: string };
  }[];
};

test('every frame is the corpus bytes', () => {
  assert.equal(corpus.frames.length, 11, 'the corpus shrank');
  for (const { name, build, body_hex } of corpus.frames) {
    const credentials = build['credentials'] as
      { name: string; password: string } | undefined;
    const vault = build['vault'] as
      { namespace: string; database: string; vault: string } | undefined;
    const body = frameBody(
      credentials
        ? { user: credentials.name, password: credentials.password }
        : undefined,
      {
        act: build['act'] as 'status' | 'unseal' | 'seal' | 'change',
        passphrase: build['passphrase'] as string | undefined,
        current: build['current'] as string | undefined,
        next: build['new'] as string | undefined,
      },
      vault ? [vault.namespace, vault.database, vault.vault] : undefined,
    );
    assert.equal(bytesToHex(body), body_hex, name);
  }
});

function rendered(build: Json): [string, Map<string, Value>] {
  const [kind, fields] = Object.entries(build)[0] as [string, Json];
  const namespace = fields['namespace'] as string;
  const database = fields['database'] as string;
  if (kind === 'audit')
    return auditStatement(namespace, database, fields['actor'] as string | undefined);
  const s = new VaultStatements(namespace, database, fields['vault'] as string);
  if (kind === 'list') {
    const after = fields['after'] ? valueOf(fields['after'] as never) : undefined;
    return s.list(after, fields['limit'] as number | undefined);
  }
  const id = valueOf(fields['id'] as never);
  switch (kind) {
    case 'reveal':
      return s.reveal(id, (fields['fields'] as string[] | undefined) ?? []);
    case 'write': {
      const given = new Map<string, Value>();
      for (const [name, value] of Object.entries(fields['fields'] as Json))
        given.set(name, valueOf(value as never));
      return s.write(id, given);
    }
    case 'recipients':
      return s.recipients(id);
    case 'add_recipient':
      return s.addRecipient(
        id,
        fields['name'] as string,
        hexToBytes(fields['key'] as string),
      );
    case 'remove_recipient':
      return s.removeRecipient(id, fields['name'] as string);
    default:
      throw new Error(`a statement the corpus does not define: ${kind}`);
  }
}

test('every statement renders or is refused as the corpus says', () => {
  assert.equal(corpus.statements.length, 19, 'the corpus shrank');
  for (const { name, build, script, parameters, refused } of corpus.statements) {
    if (refused) {
      assert.throws(
        () => rendered(build),
        (error: unknown) =>
          error instanceof VaultArgumentError && error.reason === refused.reason,
        name,
      );
      continue;
    }
    const [text, given] = rendered(build);
    assert.equal(text, script, name);
    const expected = new Map(
      Object.entries(parameters ?? {}).map(([key, value]) => [
        key,
        valueOf(value as never),
      ]),
    );
    assert.deepEqual(given, expected, name);
  }
});

function statusValue(state: string, more: [string, Value][] = []): Value {
  return {
    kind: 'object',
    fields: new Map<string, Value>([
      ['state', { kind: 'string', value: state }],
      ['unseal_for', { kind: 'duration', seconds: 600n, nanos: 0 }],
      ...more,
    ]),
  };
}

test('a status reads its states, its instant and its custody from closed sets', () => {
  assert.equal(readStatus(statusValue('sealed')).state, 'sealed');
  const open = readStatus(
    statusValue('unsealed', [
      ['seals_at', { kind: 'datetime', seconds: 1_790_000_000n, nanos: 0 }],
      ['custody', { kind: 'string', value: 'own' }],
    ]),
  );
  assert.equal(open.state, 'unsealed');
  assert.equal(open.sealsAt?.getTime(), 1_790_000_000_000);
  assert.equal(open.unsealForMs, 600_000);
  assert.equal(open.custody, 'own');
  assert.equal(readStatus(statusValue('sealed')).custody, undefined);
  assert.throws(() => readStatus(statusValue('ajar')));
  assert.throws(() =>
    readStatus(
      statusValue('sealed', [['custody', { kind: 'string', value: 'shared' }]]),
    ),
  );
});

const target = process.env['TESSARIDB_TEST_NODE'];
const runs = target ? test : test.skip;
const PASSPHRASE = 'an operator passphrase 4b71';
const NEXT = 'the next passphrase 9c02';
const TEAM = 'the team passphrase 5d13';
const PLANTED = 'correct-horse-battery-staple-9f2b';
const text = (value: string): Value => ({ kind: 'string', value });
const shown = (error: unknown): string => `${String(error)} ${JSON.stringify(error)}`;

async function node(t: TestContext): Promise<Connection> {
  const [host, port] = (target ?? '').split(':');
  const connection = await connect({
    host: host ?? '127.0.0.1',
    port: Number(port ?? 0),
  });
  t.after(() => connection.close());
  return connection;
}

runs('the whole vault contract against a node', async (t) => {
  const conn = await node(t);
  const first = await unseal(conn, PASSPHRASE);
  if (!first.initialised) {
    t.skip('the node already has a passphrase; run against an empty store');
    return;
  }
  assert.equal(first.state, 'unsealed');
  assert.ok(first.sealsAt);
  await conn.execute(
    'DEFINE NAMESPACE app; USE NAMESPACE app; DEFINE DATABASE main; USE DATABASE main; ' +
      "DEFINE VAULT team; DEFINE FIELD 'password' ON team TYPE string SECRET; " +
      'DEFINE FIELD login ON team TYPE string;',
  );
  const vault = new Vault(conn, 'app', 'main', 'team');
  await vault.write(
    'github',
    new Map([
      ['password', text(PLANTED)],
      ['login', text('boog')],
    ]),
  );
  await vault.write('gitlab', new Map([['password', text('second')]]));
  await vault.write('github', new Map([['password', text(PLANTED)]]));

  const firstPage = await vault.list({ limit: 1 });
  assert.deepEqual(firstPage.ids, [text('github')]);
  const secondPage = await vault.list({ after: firstPage.next, limit: 1 });
  assert.deepEqual(secondPage.ids, [text('gitlab')]);
  const last = await vault.list({ after: secondPage.next, limit: 1 });
  assert.deepEqual([last.ids, last.next], [[], undefined]);

  const revealed = await vault.reveal('github', ['password']);
  assert.deepEqual(revealed, new Map([['password', text(PLANTED)]]));
  assert.deepEqual(await vault.reveal('github'), revealed);

  await vault.addRecipient('github', 'bob', new Uint8Array([1, 2, 3]));
  assert.deepEqual(
    await vault.recipients('github'),
    new Map([['bob', new Uint8Array([1, 2, 3])]]),
  );
  await vault.removeRecipient('github', 'bob');
  assert.deepEqual(await vault.recipients('github'), new Map());
  await assert.rejects(vault.removeRecipient('github', 'bob'), RefusalError);

  const trail = await vaultAudit(conn, 'app', 'main');
  assert.ok(trail.length >= 2);
  assert.ok(
    !JSON.stringify(trail, (_, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v,
    ).includes(PLANTED),
  );

  const wrong = await changePassphrase(conn, 'not it', NEXT).catch((e: unknown) => e);
  assert.ok(
    wrong instanceof RefusalError && !shown(wrong).includes(NEXT),
    shown(wrong),
  );
  await changePassphrase(conn, PASSPHRASE, NEXT);
  assert.equal((await seal(conn)).state, 'sealed');
  const old = await unseal(conn, PASSPHRASE).catch((e: unknown) => e);
  assert.ok(
    old instanceof RefusalError && !shown(old).includes(PASSPHRASE),
    shown(old),
  );
  assert.equal((await unseal(conn, NEXT)).state, 'unsealed');
  assert.deepEqual(await vault.reveal('github', ['password']), revealed);

  // A vault with its own passphrase: the store's opens nothing in it.
  await conn.execute(
    `USE NAMESPACE app; USE DATABASE main; DEFINE VAULT own PASSPHRASE '${TEAM}'; ` +
      'DEFINE FIELD token ON own TYPE string SECRET;',
  );
  const own = new Vault(conn, 'app', 'main', 'own');
  const status = await own.status();
  assert.deepEqual([status.custody, status.state], ['own', 'unsealed']);
  await own.write('github', new Map([['token', text(PLANTED)]]));
  assert.equal((await own.seal()).state, 'sealed');
  const refused = await own.unseal(NEXT).catch((e: unknown) => e);
  assert.ok(
    refused instanceof RefusalError && !shown(refused).includes(NEXT),
    shown(refused),
  );
  assert.equal((await own.unseal(TEAM)).state, 'unsealed');
  await own.changePassphrase(TEAM, 'the next team one');
  assert.deepEqual(
    await own.reveal('github', ['token']),
    new Map([['token', text(PLANTED)]]),
  );
  assert.equal((await vault.status()).custody, 'store');
  await assert.rejects(vault.unseal(NEXT), RefusalError);
});

test('a limit out of range and an empty write are refused before sending', () => {
  const s = new VaultStatements('app', 'main', 'team');
  assert.throws(() => s.list(undefined, 0), VaultArgumentError);
  assert.throws(() => s.write(text('x'), new Map()), VaultArgumentError);
});
