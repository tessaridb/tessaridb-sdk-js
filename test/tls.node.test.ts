import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  HandshakeError,
  HttpClient,
  IoError,
  TlsError,
  TruncatedError,
  connect,
} from '../src/index.ts';

/**
 * TLS to a node (protocol §1.1), against a node started with a certificate.
 *
 *   TESSARIDB_TEST_TLS_NODE=127.0.0.1:47919 TESSARIDB_TEST_TLS_HTTP=127.0.0.1:47920 \
 *   TESSARIDB_TEST_TLS_AUTHORITY=ca.pem TESSARIDB_TEST_TLS_OTHER_AUTHORITY=other.pem \
 *   NODE_EXTRA_CA_CERTS=ca.pem npm test
 *
 * `NODE_EXTRA_CA_CERTS` is how `fetch` is told about a private authority; the
 * wire takes its authority as an option.
 */
const wire = process.env['TESSARIDB_TEST_TLS_NODE'];
const http = process.env['TESSARIDB_TEST_TLS_HTTP'];
const authority = process.env['TESSARIDB_TEST_TLS_AUTHORITY'];
const other = process.env['TESSARIDB_TEST_TLS_OTHER_AUTHORITY'];
const runs = wire && http && authority && other ? test : test.skip;

function at(address: string | undefined): { host: string; port: number } {
  const [host, port] = (address ?? '').split(':');
  return { host: host ?? '127.0.0.1', port: Number(port ?? 0) };
}

runs(
  'a client that verified the node is answered on the wire and over HTTP',
  async () => {
    const connection = await connect({
      ...at(wire),
      tls: { ca: readFileSync(authority ?? '', 'utf8') },
    });
    try {
      const reply = await connection.execute('RETURN 40 + 2;');
      assert.equal(reply.kind, 'answer');
      const outcome = reply.kind === 'answer' ? reply.outcomes[0] : undefined;
      assert.equal(outcome?.kind, 'value');
      assert.deepEqual(outcome?.kind === 'value' ? outcome.value : undefined, {
        kind: 'integer',
        value: 42n,
      });
    } finally {
      await connection.close();
    }
    const health = await new HttpClient({ ...at(http), secure: true }).health();
    assert.equal(health.status, 'ok');
  },
);

runs('a client in the clear is not answered', async () => {
  // What comes back is a TLS alert: not the protocol's greeting, or nothing.
  await assert.rejects(
    connect({ ...at(wire), timeout: 2_000 }),
    (why: unknown) =>
      why instanceof HandshakeError ||
      why instanceof IoError ||
      why instanceof TruncatedError,
  );
  // `fetch` reports a reply that is not HTTP as a TypeError.
  await assert.rejects(new HttpClient({ ...at(http) }).health(), TypeError);
});

runs('a client trusting another authority refuses the node', async () => {
  await assert.rejects(
    connect({ ...at(wire), tls: { ca: readFileSync(other ?? '', 'utf8') } }),
    TlsError,
  );
});
