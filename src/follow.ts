/**
 * What following a redirect (protocol §3.12) checks, apart from the connection
 * that does it.
 *
 * - At most three hops: a fourth redirect is a loop, or a cluster moving faster
 *   than a request can follow it, and going on would not tell them apart.
 * - Epochs never go backwards: a redirect dated by an older leadership than one
 *   already followed was decided before it, and points at the past.
 * - The node there is the node named: `session::context()` on arrival says which
 *   node took the connection.
 * - The tenancy goes with the request, each name checked as a plain name and
 *   never quoted into a script.
 */

import { NotFollowableError, ProtocolError } from './error.ts';
import type { Reply } from './connection.ts';
import type { Value } from './value.ts';

export const MOST_HOPS = 3;
export const CONTEXT = 'RETURN session::context();';
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What `session::context()` answered. */
export interface Context {
  node: Uint8Array | undefined;
  namespace: string | undefined;
  database: string | undefined;
}

/** The context a reply to {@link CONTEXT} carries. */
export function contextOf(reply: Reply): Context {
  const last = reply.kind === 'answer' ? reply.outcomes.at(-1) : undefined;
  if (last?.kind !== 'value' || last.value.kind !== 'object') {
    throw new ProtocolError('session::context() answers one object');
  }
  const fields = last.value.fields;
  const node = fields.get('node');
  return {
    node: node?.kind === 'uuid' ? node.value : undefined,
    namespace: text(fields.get('namespace')),
    database: text(fields.get('database')),
  };
}

function text(value: Value | undefined): string | undefined {
  return value?.kind === 'string' ? value.value : undefined;
}

/** The `USE` that selects `context`'s tenancy again, or `undefined`. */
export function selection(context: Context): string | undefined {
  let script = '';
  for (const [word, name] of [
    ['NAMESPACE', context.namespace],
    ['DATABASE', context.database],
  ] as const) {
    if (name === undefined) continue;
    if (!PLAIN.test(name)) throw new NotFollowableError(name);
    script += `USE ${word} ${name}; `;
  }
  return script === '' ? undefined : script;
}

/** Whether two node identities are the same sixteen bytes. */
export function sameNode(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return (
    a !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i])
  );
}
