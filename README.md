# @tessaridb/client

A client for [TessariDB](https://tessaridb.com) in TypeScript, written from the
[protocol specification](https://github.com/tessaridb/tessaridb-protocol) and
nothing else.

> **Status: early.** The wire half is complete — the value codec, the connection
> and the query builder, each proven against the shared conformance corpora and
> exercised against a running node. The HTTP surface is not written yet — see
> [What works today](#what-works-today).

```
npm install @tessaridb/client
```

Node.js 22 or newer. Apache-2.0.

## What works today

|                                                    |                                               |
| -------------------------------------------------- | --------------------------------------------- |
| value codec — all seventeen types, both directions | **done**, 54/54 corpus vectors                |
| wire connection, greeting, statements, answers     | **done**, exercised against a running node    |
| change subscription                                | **done**, exercised against a running node    |
| query builder                                      | **done**, 30/30 corpus, 21 executed by a node |
| HTTP surface — objects, files, backup, health      | not yet                                       |

The codec is usable on its own if you are writing tooling around the wire format:

```ts
import { encodeValue, decodeValue } from '@tessaridb/client';

const bytes = encodeValue({ kind: 'integer', value: 42n });
const back = decodeValue(bytes); // { kind: 'integer', value: 42n }
```

## Writing a statement

The builder covers `SELECT`, `CREATE`, `UPDATE` and `DELETE` over one collection.
Anything else you write as a script and send as one, which is always available.

```ts
import { connect, select, compare } from '@tessaridb/client';

const connection = await connect({ host: '127.0.0.1', port: 9080 });

const { script, parameters } = select('memories')
  .field('body')
  .where(compare('session', 'eq', { kind: 'string', value: 'abc' }))
  .orderBy('created', 'desc')
  .limit(50)
  .render();

// SELECT body FROM memories WHERE session = $p0 ORDER BY created DESC LIMIT 50;
const reply = await connection.execute(script, parameters);
```

**A value you pass never reaches the statement text.** Every one becomes a bound
parameter; the text carries the reference and the value travels beside it, encoded.
So a string that spells a statement is stored as a string that spells a statement.

Names are the other half of that, and they are not values — a table or field name
is grammar, so a parameter cannot supply one and it is written into the text
directly. That is safe only because each is checked first, against a deliberately
narrow production (`[A-Za-z_][A-Za-z0-9_]*`), and a string that is not a name is
**refused rather than quoted into acceptance** — quoting would turn your mistake
into a statement that runs and means something else.

```ts
select('memories; DROP COLLECTION memories; --');
// BuilderError: reason 'not-a-name', position 'a table'
```

The rendering itself is fixed by a shared contract rather than by this package, so
the same query built in any client language produces the same text and the same
parameter numbering. That is what the corpus checks, and this client additionally
executes every rendered case against a running node — the only check that reaches
the parser.

## Two transports, and the choice is forced

A node serves two surfaces and neither carries everything. Statements and change
subscriptions go over the **binary wire protocol**, because it carries the store's
full model of seventeen value types. Objects, files, backup and the operational
routes go over **HTTP**, because nothing else serves them.

A caller never picks a transport per call. Routing statements over HTTP would
work, reach every route, and silently narrow every result — JSON carries six types
against the store's seventeen — and nothing at the call site would show what was
lost.

## Why there is no browser build

A browser cannot open a TCP socket, so a browser build could only ever be the HTTP
half — which means shipping the narrowing described above as though it were the
client. If you need database access from a browser, put a server in front of it;
that server is also where your credentials belong.

This package runs on Node.js 22+ and on the runtimes that implement `node:net`,
which today are Deno and Bun.

**22 and not 20, for one reason.** A record identity is an `i64`, and
`JSON.parse` reads every number as a double — so an id past 2^53 comes back
changed, with nothing anywhere reporting it. The fix is the parser's source-text
access, which arrived in Node 22. On a runtime without it this client refuses to
read the body rather than reading it wrongly.

## There is no TLS on the wire protocol

Credentials travel as given. Run this on a protected network, or behind something
that terminates TLS. This is a property of the protocol, not an omission in the
client, and it is stated here rather than left to be discovered.

## Values

The store's model has seventeen types and two of its distinctions disappear in
every JSON-shaped client. Both are kept here.

`none` and `null` are different — _the field is not present_ versus _the field is
present and holds nothing_. And an integer is an `i64`, carried as a `bigint`,
because a JavaScript number silently loses precision above 2^53, which is well
inside the range the store accepts.

Floating point is a `number`: the bits of a JS double are the bits the protocol
asks for, so `-0` survives and so does the canonical quiet NaN. The one value a
`number` cannot hold is a NaN with a non-canonical payload — JavaScript normalises
it — so such a value would decode to `NaN` and re-encode to the canonical pattern.
No node emits one.

Coordinates are **longitude first**, as RFC 7946 fixes, and are carried as bits
rather than text. The opposite order is the most common bug in geospatial code
precisely because it is silent: a point in Paris becomes a point in the Indian
Ocean, which is a perfectly valid place.

## Conformance

This client is checked against the corpora in the protocol repository, which are
generated by a **second implementation written from the specification alone**.
That matters more than it sounds: a codec that is wrong in the same way on both
sides round-trips perfectly, so a suite written alongside this codec cannot catch
what the corpus catches. Both directions are run — encode to exactly the stated
bytes, and decode to exactly the stated value.

The query corpus is the same idea applied to text: the rendering must be
byte-identical and the parameter numbering must match, so that the same query
built in any client language is the same statement. Cases the contract says a
builder must refuse are asserted as refusals, with the stated reason, and are
never rendered.

Both of those establish only that two implementations of a written document
agree. Neither reaches the node's parser — no client may link it — so the suite
additionally **executes every rendered case against a running node**, which is the
only check that does:

```
TESSARIDB_TEST_NODE=127.0.0.1:47915 npm test
```

Those tests are opt-in and skip loudly when the variable is unset; a suite that
needs a server cannot be the suite that runs on a clean checkout.

```
npm test          # expects ../tessaridb-protocol checked out beside this repo,
                  # or TESSARI_PROTOCOL_CONFORMANCE pointing at the corpus
```

A missing corpus fails loudly rather than skipping: a suite that passes having
found nothing reports coverage it does not have.

## Development

```
npm run check     # typecheck + format + tests
npm run build     # emits dist/ with declarations
```

No runtime dependencies, and that is deliberate — this package handles
credentials, and every dependency is supply-chain surface inside it.

## Licence

Apache-2.0. The engine is licensed separately; the two are distinct decisions.
