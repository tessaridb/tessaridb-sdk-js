# @tessaridb/client

A client for [TessariDB](https://tessaridb.com) in TypeScript, written from the
[protocol specification](https://github.com/tessaridb/tessaridb-protocol) and
nothing else.

> **Status: early.** Both transports are in: the value codec, the connection and
> the query builder on the wire, and the object, file, backup and operational
> routes over HTTP. Each is proven against the shared conformance corpora and
> exercised against a running node — see [What works today](#what-works-today).

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
| HTTP surface — objects, files, backup, health      | **done**, exercised against a running node    |
| session token — §5.8                               | **done**, open once, `Bearer` thereafter      |

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

## Objects, files and health

Everything the wire protocol does not serve is here, and it is a different client
because it is a different surface rather than an alternative to the first one.

```ts
import { HttpClient } from '@tessaridb/client';

const node = new HttpClient({
  host: '127.0.0.1',
  port: 8000,
  credentials: { user: 'app', password: process.env.TESSARIDB_PASSWORD },
});

await node.put('acme', 'app', 'uploads', 'reports/100% done.pdf', bytes);
const back = await node.get('acme', 'app', 'uploads', 'reports/100% done.pdf');
const listing = await node.list('acme', 'app', 'uploads');
const health = await node.health();
```

**The password is spent once.** A node verifies Basic with Argon2id at the OWASP
floor, and HTTP has no connection to hang a session on, so that cost is paid on
_every_ request that carries one. This client opens a session on its first
authenticated call and presents the token after — and when a token stops working,
which it does four different ways that all answer `401`, it signs in again and
retries once, without the caller seeing it.

A client that skipped this would be correct, would pass every test, and would be
slower than the protocol intends by an order of magnitude. Measured against a
debug build over loopback, on a statement that does nothing: **31.5 ms per request
with a password against 14.7 ms with a token.** On a real deployment the gap is
larger, because the work being repeated is the same and the work being avoided is
not.

**`node.script()` takes no parameters, and that is deliberate.** A parameter on
this route is a JSON string carrying _TessariQL source_, not a value — `{"x":"3"}`
is the number 3 and `{"x":"hello"}` is a `400`. Passing a caller's string through
would be a type-confusion hazard that no test written against it would show, so
this client does not build the bridge: a statement with a value in it goes over
the wire, where a parameter is an encoded value and none of this arises.

**A `404` is an answer.** A file that is not there reads as `undefined`, and a
file that exists and is empty reads as zero bytes — these are different facts and
the server draws the line, so this client does not erase it. A listing that comes
back `undefined` means the name is not a bucket; an empty array means the bucket
is there and holds nothing.

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
