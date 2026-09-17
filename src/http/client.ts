/**
 * The HTTP half of the client (§5).
 *
 * It exists because the wire protocol does not serve objects, files, backup or
 * the operational routes — not because it is an alternative way to run
 * statements. `POST /script` is here, but a statement with a parameter belongs on
 * the wire, and §5.5 is the reason: a parameter on this route is a JSON string
 * carrying **TessariQL source**, not a value, so `{"x": "3"}` is the number 3 and
 * `{"x": "hello"}` is a `400`. Clause 7 of §7 forbids that requirement travelling
 * back to the wire, and the safest way to honour it is not to build the bridge:
 * this client sends a plain-body script and offers no parameter map here.
 *
 * ## The session token is not an optimisation
 *
 * Basic here is verified with Argon2id at the OWASP floor, and HTTP has no
 * connection to hang a session on, so that cost is paid on **every** request. A
 * client that presents a password everywhere is correct, passes every test, and
 * is slower than the protocol intends by more than an order of magnitude — 2.5
 * seconds for seventeen statements on a real deployment, of which about 99 % was
 * re-proving an identity the caller already held. So this client opens a session
 * on the first authenticated call and presents the token thereafter.
 */

import { Buffer } from 'node:buffer';
import { ProtocolError, RefusalError } from '../error.ts';
import { readAnswerBody, type HttpOutcome } from './answer.ts';
import { type JsonValue, parseJson } from './json.ts';

/** A node's answer to `/health` or `/ready`. Three shapes, three field sets. */
export type Health =
  | { readonly status: 'ok'; readonly committed: bigint }
  | {
      readonly status: 'unwell';
      readonly committed: bigint;
      readonly backgroundErrors: number;
      readonly complaint: string;
    }
  /** A node leaving carries no commit position — there is none to report. */
  | { readonly status: 'leaving' };

/** One entry of a bucket listing. `size` and `updated` appear only where recorded. */
export interface FileEntry {
  readonly path: string;
  readonly size?: number;
  readonly updated?: string;
}

/**
 * The node declined, and the status is what a client branches on.
 *
 * The sentence is for a person: it frequently embeds the caller's own input and
 * is not a stable identifier. `401` means sign in; `403` means the grants do not
 * cover this and signing in again will never help.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A `307`: this node cannot answer within the staleness bound, and another can. */
export class ElsewhereError extends Error {
  override readonly name = 'ElsewhereError';
  readonly location: string;

  constructor(location: string, message: string) {
    super(message);
    this.location = location;
  }
}

export interface HttpOptions {
  readonly host: string;
  readonly port: number;
  readonly credentials?: { readonly user: string; readonly password: string };
}

const SEGMENT = /^[A-Za-z0-9_]+$/;

function segment(value: string, what: string): string {
  // These are names interpolated into a statement, and the check is what makes
  // that safe. It happens here rather than at the server.
  if (!SEGMENT.test(value)) {
    throw new ProtocolError(
      `${what} must match [A-Za-z0-9_]+, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * Percent-encodes a file's name.
 *
 * The server decodes this, so a client must encode it — and not approximately.
 * An unencoded space makes the request *line* unparseable rather than merely
 * wrong, and an unencoded `%` asks the server to decode an escape the caller
 * never wrote. A slash is left as itself: a slash inside a file's name is part of
 * the name and reaches the server as one. Encoding more than the minimum is safe;
 * encoding less is not, which is why this does not use `encodeURIComponent` —
 * that one leaves `!*'()` alone.
 */
function encodeFilePath(path: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(path)) {
    const char = String.fromCharCode(byte);
    out +=
      UNRESERVED.test(char) || char === '/'
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function whole(json: JsonValue | undefined, what: string): bigint {
  if (typeof json === 'bigint') return json;
  if (typeof json === 'number' && Number.isInteger(json)) return BigInt(json);
  throw new ProtocolError(`${what} must be a whole number`);
}

export class HttpClient {
  readonly #origin: string;
  readonly #credentials: HttpOptions['credentials'];
  #token: string | undefined;

  constructor(options: HttpOptions) {
    this.#origin = `http://${options.host}:${options.port}`;
    this.#credentials = options.credentials;
  }

  /** The token this client holds, if it has opened a session. Opaque — 64 hex characters. */
  get token(): string | undefined {
    return this.#token;
  }

  /**
   * Spends the password once for a token.
   *
   * Returns `false` on an **open store**, which answers `401` because there is no
   * session to open — a token cut from the absence of a credential would still
   * work after the first `DEFINE USER` closed the store. That is not a failure to
   * retry; there is simply nothing to prove and nothing to save. A `503` is the
   * node holding its ceiling of tokens and *is* retriable, so the two are kept
   * apart rather than both reported as "could not sign in".
   */
  async openSession(): Promise<boolean> {
    if (!this.#credentials) return false;
    const response = await fetch(`${this.#origin}/session`, {
      method: 'POST',
      headers: { Authorization: this.#basic() },
    });
    if (response.status === 401) {
      await response.text();
      this.#token = undefined;
      return false;
    }
    const body = await this.#body(response);
    const object = this.#object(body, 'a session');
    const token = object['token'];
    if (typeof token !== 'string')
      throw new ProtocolError('a session answer must carry `token`');
    this.#token = token;
    return true;
  }

  /** Gives the token back. Answers the same whether or not the node held it. */
  async closeSession(): Promise<void> {
    if (this.#token === undefined) return;
    await this.#body(await this.#send('/session', { method: 'DELETE' }));
    this.#token = undefined;
  }

  async health(): Promise<Health> {
    return this.#condition('/health');
  }

  /**
   * Not a synonym for `health`, and never implemented in terms of it.
   *
   * They answer identically on a well node and diverge during a staged shutdown,
   * where this one reports `leaving` while `/health` still reports `ok` — and that
   * window is the whole reason both exist. A supervisor reads *not ready* as stop
   * sending traffic here and *not healthy* as restart this.
   */
  async ready(): Promise<Health> {
    return this.#condition('/ready');
  }

  /**
   * Runs a script and returns one outcome per statement.
   *
   * No parameters: see the note at the top of this file. A script is
   * all-or-nothing in its RESPONSE — a failure reports that statement's error and
   * none of the outcomes that already succeeded — but not in the store, where the
   * earlier statements have taken effect and are durable. So this never retries,
   * and a caller who needs atomicity writes `BEGIN` … `COMMIT`.
   */
  async script(source: string): Promise<HttpOutcome[]> {
    const response = await this.#send('/script', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: source,
    });
    return readAnswerBody(await this.#body(response));
  }

  /** The whole log, in one response. There is no resumption and no range support. */
  async backup(from?: bigint): Promise<Uint8Array> {
    const query = from === undefined ? '' : `?from=${from}`;
    const response = await this.#send(`/backup${query}`, { method: 'GET' });
    await this.#raise(response);
    this.#framing(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(
    ns: string,
    db: string,
    bucket: string,
    path: string,
    body: Uint8Array,
  ): Promise<void> {
    const response = await this.#send(this.#file(ns, db, bucket, path), {
      method: 'PUT',
      // A Uint8Array is a valid body; the DOM lib's type for it is not loaded here.
      body: body as unknown as string,
    });
    await this.#body(response);
  }

  /**
   * Reads a file, or `undefined` when there is none.
   *
   * `404` is an **answer** here and it is not the same as a file that exists and
   * is empty — that answers `200` with no bytes. Reporting both as "no bytes"
   * would erase a distinction the server draws.
   */
  async get(
    ns: string,
    db: string,
    bucket: string,
    path: string,
  ): Promise<Uint8Array | undefined> {
    const response = await this.#send(this.#file(ns, db, bucket, path), {
      method: 'GET',
    });
    if (response.status === 404) {
      await response.text();
      return undefined;
    }
    await this.#raise(response);
    this.#framing(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Lists a bucket, or `undefined` when the name is not one.
   *
   * A name declared as something else and a name nothing declared are both `404`,
   * and never `200` with an empty list — so an empty listing means the bucket is
   * there and holds nothing, which is a different fact. The body's sentence says
   * which of the two a `404` was; it is not specified which sentence a given
   * route returns, so this client surfaces it and branches on the status.
   */
  async list(ns: string, db: string, bucket: string): Promise<FileEntry[] | undefined> {
    const path = `/files/${segment(ns, 'a namespace')}/${segment(db, 'a database')}/${segment(bucket, 'a bucket')}`;
    const response = await this.#send(path, { method: 'GET' });
    if (response.status === 404) {
      await response.text();
      return undefined;
    }
    const body = this.#object(await this.#body(response), 'a bucket listing');
    const files = body['files'];
    if (!Array.isArray(files))
      throw new ProtocolError('a bucket listing must carry `files`');
    return files.map((one) => {
      const entry = this.#object(one, 'a listed file');
      const filePath = entry['path'];
      if (typeof filePath !== 'string')
        throw new ProtocolError('a listed file must carry `path`');
      const listed: { -readonly [K in keyof FileEntry]: FileEntry[K] } = {
        path: filePath,
      };
      // Present only where the store recorded them, and never as a null — the
      // absence says it was never recorded rather than that it was recorded empty.
      if (typeof entry['size'] === 'number') listed.size = entry['size'];
      if (typeof entry['updated'] === 'string') listed.updated = entry['updated'];
      return listed;
    });
  }

  /** Idempotent: `204` whether or not the file was there, and the server says no more. */
  async remove(ns: string, db: string, bucket: string, path: string): Promise<void> {
    const response = await this.#send(this.#file(ns, db, bucket, path), {
      method: 'DELETE',
    });
    await this.#raise(response);
  }

  #file(ns: string, db: string, bucket: string, path: string): string {
    // A trailing slash names a file called `/`, not the bucket. Normalised away
    // here because "list the bucket" and "read the file named /" must not be one
    // keystroke apart.
    const name = path.replace(/\/+$/, '');
    if (name === '')
      throw new ProtocolError('a file path is required — use list() for a bucket');
    return `/files/${segment(ns, 'a namespace')}/${segment(db, 'a database')}/${segment(bucket, 'a bucket')}/${encodeFilePath(name)}`;
  }

  #basic(): string {
    const { user, password } = this.#credentials!;
    return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
  }

  async #send(path: string, init: RequestInit, mayRetry = true): Promise<Response> {
    if (this.#credentials && this.#token === undefined && mayRetry) {
      await this.openSession();
    }

    const headers = new Headers(init.headers);
    if (this.#token !== undefined)
      headers.set('Authorization', `Bearer ${this.#token}`);
    else if (this.#credentials) headers.set('Authorization', this.#basic());

    const response = await fetch(`${this.#origin}${path}`, { ...init, headers });

    // A token ends four ways and they all answer 401, which is why the client
    // does the same thing for all four: discard it, sign in again, retry ONCE.
    if (response.status === 401 && this.#token !== undefined && mayRetry) {
      await response.text();
      this.#token = undefined;
      if (await this.openSession()) return this.#send(path, init, false);
    }
    return response;
  }

  async #condition(route: string): Promise<Health> {
    const response = await fetch(`${this.#origin}${route}`);
    // 503 here is an ANSWER — the node replied to the question it was asked —
    // and treating it as a transport failure loses the reply.
    if (response.status !== 200 && response.status !== 503) {
      throw new HttpError(response.status, await response.text());
    }
    this.#framing(response);
    const body = this.#object(parseJson(await response.text()), route);
    switch (body['status']) {
      case 'ok':
        return { status: 'ok', committed: whole(body['committed'], '`committed`') };
      case 'unwell':
        return {
          status: 'unwell',
          committed: whole(body['committed'], '`committed`'),
          backgroundErrors: Number(
            whole(body['background_errors'], '`background_errors`'),
          ),
          complaint: String(body['complaint'] ?? ''),
        };
      case 'leaving':
        return { status: 'leaving' };
      default:
        // Mapping an unknown status onto the nearest known one would report a
        // condition the node did not describe.
        throw new ProtocolError(
          `unknown node status ${JSON.stringify(body['status'])}`,
        );
    }
  }

  #framing(response: Response): void {
    // §5.3 says every response on this surface declares its length and none is
    // chunked, and names `GET /backup` as the one that must declare it anyway.
    //
    // Measured against `0.3.0-beta`: that route chunks once the log is big
    // enough — a ~23 kB backup declared a length and a ~38 kB one did not — so
    // refusing here made `backup()` fail on exactly the stores that have
    // something worth backing up, while passing every test written against a
    // fresh one.
    //
    // The refusal §5.3 asks for is for a framing a client does not RECOGNISE.
    // Chunked is recognised: the transport de-chunks it before the body is
    // read, so nothing is guessed at and nothing can be silently truncated.
    // A framing that is neither is still refused, which is what this guard was
    // for.
    if (response.headers.get('content-length') !== null) return;
    const framing = response.headers.get('transfer-encoding') ?? '';
    if (framing.toLowerCase().includes('chunked')) return;
    throw new ProtocolError(
      'the node answered with neither a Content-Length nor a framing this client reads',
    );
  }

  async #raise(response: Response): Promise<void> {
    if (response.ok) return;
    if (response.status === 307) {
      const location = response.headers.get('location');
      const message = await response.text();
      // A redirect is an instruction, not a failure, and the address is in the
      // header — a redirect whose target must be parsed out of prose is not one.
      if (location === null) throw new ProtocolError('a 307 without a Location');
      throw new ElsewhereError(location, message);
    }
    const text = await response.text();
    let sentence = text;
    try {
      const body = parseJson(text);
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        sentence = String(body['error'] ?? text);
      }
    } catch {
      // A refusal whose body is not the documented shape still has a status,
      // which is the part a client branches on.
    }
    if (response.status === 400) throw new RefusalError('refused', sentence);
    throw new HttpError(response.status, sentence);
  }

  async #body(response: Response): Promise<JsonValue> {
    await this.#raise(response);
    this.#framing(response);
    const text = await response.text();
    return text === '' ? null : parseJson(text);
  }

  #object(json: JsonValue, what: string): { [key: string]: JsonValue } {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new ProtocolError(`${what} must be a JSON object`);
    }
    return json;
  }
}
