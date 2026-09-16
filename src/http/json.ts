/**
 * Reading a JSON body without losing an integer.
 *
 * `JSON.parse` reads every number as a double, and the store's integers are
 * `i64` — so `9223372036854775807` comes back as `…808` and nothing anywhere
 * reports it. The conformance corpus carries that exact value and says a client
 * whose reader loses it should fail there.
 *
 * The fix is the parser's source-text access: the reviver is handed the literal
 * as it was written, so an integer literal too large for a double is kept as a
 * `bigint` and everything else stays a `number`. A runtime without it is refused
 * rather than quietly downgraded — losing precision silently is the one outcome
 * worth failing to start over.
 */

/** A parsed JSON value. `bigint` appears only for an integer a double would lose. */
export type JsonValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class JsonError extends Error {
  override readonly name = 'JsonError';
}

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

const HAS_SOURCE_ACCESS = ((): boolean => {
  let seen = false;
  const probe: Reviver = (_key, value, context) => {
    seen = typeof context?.source === 'string';
    return value;
  };
  JSON.parse('1', probe as never);
  return seen;
})();

/** A literal with no fraction and no exponent is an integer, whatever its size. */
const FRACTIONAL = /[.eE]/;

export function parseJson(text: string): JsonValue {
  if (!HAS_SOURCE_ACCESS) {
    throw new JsonError(
      'this runtime cannot read a JSON number without losing an i64 — Node 22 or newer is required, ' +
        'and reading the body anyway would lose record identities silently',
    );
  }

  const keepIntegers: Reviver = (_key, value, context) => {
    if (typeof value !== 'number' || Number.isSafeInteger(value)) return value;
    const source = context?.source;
    if (source === undefined || FRACTIONAL.test(source)) return value;
    return BigInt(source);
  };

  return JSON.parse(text, keepIntegers as never) as JsonValue;
}
