import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { connect, RefusalError } from '../src/index.ts';
import type { Connection, Outcome, Rendered, Value } from '../src/index.ts';
import { readCorpus, valueOf } from './corpus.ts';
import { render } from './build.ts';

/**
 * The query corpus executed against a running node.
 *
 * Rendering agreement is the offline half, and it is weaker than it looks: it
 * proves two implementations of the rendering contract agree with each other, and
 * nothing more. Neither of them can link the node's parser — no client may — so
 * both could be wrong together and the corpus would still be green.
 *
 * This is the half that reaches the parser, and the contract asks for it (§6.4)
 * from any client that can reach a node. Opt-in for the same reason as the other
 * live tests: a suite that needs a server cannot be the suite that runs on a
 * clean checkout.
 *
 *   TESSARIDB_TEST_NODE=127.0.0.1:47915 npm test
 */
const target = process.env['TESSARIDB_TEST_NODE'];
const runs = target ? test : test.skip;

if (!target) {
  console.log('query node run skipped: set TESSARIDB_TEST_NODE=<host:port> to run it');
}

function address(): { host: string; port: number } {
  const [host, port] = (target ?? '').split(':');
  return { host: host ?? '127.0.0.1', port: Number(port ?? 0) };
}

const SCHEMA = `
DEFINE NAMESPACE IF NOT EXISTS corpus;
USE NAMESPACE corpus;
DEFINE DATABASE IF NOT EXISTS queries;
USE DATABASE queries;
DEFINE COLLECTION IF NOT EXISTS memories;
`;

const USE = 'USE NAMESPACE corpus; USE DATABASE queries;';

/** The corpus names one collection, so each case starts from an empty one. */
const EMPTY = 'DELETE FROM memories WHERE true LIMIT ALL;';

async function run(connection: Connection, statement: Rendered): Promise<void> {
  const reply = await connection.execute(
    statement.script,
    statement.parameters as Map<string, Value>,
  );
  assert.equal(
    reply.kind,
    'answer',
    `the node answered ${reply.kind} for: ${statement.script}`,
  );
}

runs('every rendered case is accepted and executed by a node', async () => {
  const corpus = readCorpus('queries-v1.json');
  const cases = corpus['cases'] as {
    name: string;
    build: Record<string, unknown>;
    needs?: { build: Record<string, unknown> }[];
    refused?: unknown;
  }[];

  const connection = await connect(address());
  try {
    await connection.execute(SCHEMA);

    let executed = 0;
    for (const c of cases) {
      if (c.refused) continue;

      await connection.execute(`${USE} ${EMPTY}`);
      await connection.execute(USE);

      // A case's `needs` are the records it acts on — an UPDATE needs the record
      // it changes. They are rendered by this same builder, so they carry the
      // corpus run rather than standing beside it as hand-written setup.
      for (const need of c.needs ?? []) {
        await run(connection, render(need.build));
      }

      try {
        await run(connection, render(c.build));
      } catch (error) {
        if (error instanceof RefusalError) {
          assert.fail(
            `${c.name}: the node refused this client's rendering — ${error.message}`,
          );
        }
        throw error;
      }
      executed += 1;
    }

    assert.ok(executed > 0, 'the corpus carried no executable case');
    console.log(`  ${executed} rendered cases accepted and executed by the node`);
  } finally {
    await connection.close();
  }
});

runs('a value that spells a statement is stored as a value', async () => {
  // The contract's one guarantee, checked where it can actually fail. Offline the
  // assertion is about text; here it is about what the store did with it.
  const hostile = "'; DROP COLLECTION memories; --";
  const connection = await connect(address());
  try {
    await connection.execute(SCHEMA);
    await connection.execute(`${USE} ${EMPTY}`);
    await connection.execute(USE);

    await run(
      connection,
      render({
        create_record: {
          table: 'memories',
          id: { string: 'hostile' },
          set: { body: { string: hostile } },
        },
      }),
    );

    const reply = await connection.execute(`${USE} SELECT * FROM memories:'hostile';`);
    assert.equal(reply.kind, 'answer');
    const outcome = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
    assert.equal(
      outcome?.kind,
      'records',
      'the collection still exists and holds the record',
    );
    const rows = (outcome as Extract<Outcome, { kind: 'records' }>).records;
    assert.equal(rows.length, 1, 'exactly the record we wrote');
    const body = rows[0]?.value;
    assert.equal(body?.kind, 'object');
    assert.deepStrictEqual(
      body?.kind === 'object' ? body.fields.get('body') : undefined,
      valueOf({ string: hostile } as never),
      'the hostile string came back as the value it was, not as syntax the node ran',
    );
  } finally {
    await connection.close();
  }
});
