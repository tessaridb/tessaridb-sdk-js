/**
 * Reading a value off the HTTP surface, with its kind supplied by the caller.
 *
 * §5.7 is a decision rather than a translation: JSON has six types and this store
 * has seventeen, so a value's type is **not recoverable from the JSON alone** for
 * most of the table. The specification says what a caller does about it — read the
 * kind from the field's declaration in the catalog, or use the wire protocol,
 * where every value carries its tag.
 *
 * This module is the first of those. Give it the JSON and the shape, and it reads
 * back the value the store held. Without a shape there is nothing honest to do:
 * `"12.34"` is a decimal or a string, `"1h30m"` is a duration or a string, and a
 * reader that guessed would be right most of the time, which is worse than being
 * wrong all of it.
 *
 * One spelling stays lossy even with the shape, and it is named rather than
 * papered over: a float `-0.0` is written `0` (§5.7.1 — positional, no trailing
 * `.0`), and no reader can tell it from `+0.0`.
 */

import type { Bound, RecordId, Value } from '../value.ts';
import { readGeometry } from './geojson.ts';
import type { JsonValue } from './json.ts';

export class InterpretError extends Error {
  override readonly name = 'InterpretError';
}

/** What the catalog says a field holds. Containers carry their element's shape. */
export type Shape =
  | { kind: 'null' }
  | { kind: 'bool' }
  | { kind: 'integer' }
  | { kind: 'decimal' }
  | { kind: 'float' }
  | { kind: 'string' }
  | { kind: 'bytes' }
  | { kind: 'duration' }
  | { kind: 'datetime' }
  | { kind: 'uuid' }
  | { kind: 'table' }
  | { kind: 'regex' }
  | { kind: 'record'; id: RecordId['kind'] }
  | { kind: 'array'; of: Shape | readonly Shape[] }
  | { kind: 'set'; of: Shape | readonly Shape[] }
  | { kind: 'object'; fields: Record<string, Shape> }
  | { kind: 'range'; of: Shape }
  | { kind: 'geometry' };

/** Table names as the answer's names block gives them, inverted for reading. */
export type Names = ReadonlyMap<string, number>;

function refuse(what: string, json: JsonValue | undefined): never {
  throw new InterpretError(
    `${what}: ${JSON.stringify(json, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))}`,
  );
}

function text(json: JsonValue | undefined, what: string): string {
  if (typeof json !== 'string') refuse(`${what} must be a JSON string`, json);
  return json;
}

const HEX = /^[0-9a-f]*$/;

function hex(source: string, what: string): Uint8Array {
  if (source.length % 2 !== 0 || !HEX.test(source)) {
    refuse(`${what} must be lowercase hex with no separators`, source);
  }
  const bytes = new Uint8Array(source.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(source.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const DECIMAL = /^-?\d+(?:\.(\d+))?$/;

function decimal(source: string): Value {
  const match = DECIMAL.exec(source);
  if (!match)
    refuse('a decimal is written as digits with an optional fraction', source);
  const fraction = match[1] ?? '';
  return {
    kind: 'decimal',
    mantissa: BigInt(source.replace('.', '')),
    scale: fraction.length,
  };
}

const NANOS = 1_000_000_000n;
const UNITS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  ms: 1_000_000n,
  s: NANOS,
  m: 60n * NANOS,
  h: 3_600n * NANOS,
};
const DURATION_PART = /(\d+)(ns|us|ms|s|m|h)/g;

/**
 * `"1h30m"`, `"1us500ns"`, `"-500ms"`.
 *
 * The store carries a duration as whole seconds plus nanoseconds in `[0, 1e9)`,
 * so a negative duration is a *smaller* second count and a positive remainder:
 * `-500ms` is `-1s + 500000000ns`. Truncating division would give `0s` and a
 * negative remainder, which is a different duration and a legal-looking one.
 */
function duration(source: string): Value {
  const negative = source.startsWith('-');
  const body = negative ? source.slice(1) : source;
  DURATION_PART.lastIndex = 0;

  let total = 0n;
  let consumed = 0;
  for (const part of body.matchAll(DURATION_PART)) {
    if (part.index !== consumed) break;
    total += BigInt(part[1]!) * UNITS[part[2]!]!;
    consumed = part.index + part[0].length;
  }
  if (consumed !== body.length || body.length === 0) {
    refuse('a duration is a sequence of count-and-unit parts', source);
  }

  if (negative) total = -total;
  let seconds = total / NANOS;
  let nanos = total % NANOS;
  if (nanos < 0n) {
    seconds -= 1n;
    nanos += NANOS;
  }
  return { kind: 'duration', seconds, nanos: Number(nanos) };
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function datetime(source: string): Value {
  const m = RFC3339.exec(source);
  if (!m) refuse('a datetime is written as RFC 3339', source);
  const [, y, mo, d, h, mi, s, fraction, sign, oh, om] = m as unknown as string[];

  let seconds = BigInt(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) /
      1000,
  );
  if (sign !== undefined) {
    const offset = BigInt(Number(oh) * 3600 + Number(om) * 60);
    seconds += sign === '-' ? offset : -offset;
  }
  // The fraction is written without trailing zeros, so `.5` is 500 000 000ns —
  // padding right rather than parsing as an integer is the whole difference.
  const nanos = fraction === undefined ? 0 : Number(fraction.padEnd(9, '0'));
  return { kind: 'datetime', seconds, nanos };
}

const BRACKETED_TABLE = /^<table (\d+)>$/;
const BRACKETED_RECORD = /^<record (\d+):(.*)>$/;

function tableId(source: string, names: Names | undefined, what: string): number {
  const bracketed = BRACKETED_TABLE.exec(source);
  if (bracketed) return Number(bracketed[1]);
  const id = names?.get(source);
  if (id === undefined) {
    refuse(`${what} names a table the answer's names block does not carry`, source);
  }
  return id;
}

function recordId(source: string, kind: RecordId['kind']): RecordId {
  switch (kind) {
    case 'integer':
      if (!/^-?\d+$/.test(source)) refuse('an integer record id', source);
      return { kind: 'integer', value: BigInt(source) };
    case 'text':
      return { kind: 'text', value: source };
    case 'uuid':
      return {
        kind: 'uuid',
        value: hex(source.replaceAll('-', ''), 'a uuid record id'),
      };
    case 'bytes':
      if (!source.startsWith('0x'))
        refuse('a bytes record id is written with a 0x prefix', source);
      return { kind: 'bytes', value: hex(source.slice(2), 'a bytes record id') };
  }
}

function record(source: string, id: RecordId['kind'], names: Names | undefined): Value {
  const bracketed = BRACKETED_RECORD.exec(source);
  if (bracketed) {
    return {
      kind: 'record',
      table: Number(bracketed[1]),
      id: recordId(bracketed[2]!, id),
    };
  }
  // The table name cannot contain a colon, so the FIRST one separates; an
  // identity may contain as many as it likes and they are part of the name.
  const colon = source.indexOf(':');
  if (colon < 0) refuse('a record is written as table:id', source);
  return {
    kind: 'record',
    table: tableId(source.slice(0, colon), names, 'a record'),
    id: recordId(source.slice(colon + 1), id),
  };
}

function bound(
  json: JsonValue | undefined,
  of: Shape,
  names: Names | undefined,
): Bound {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    refuse('a range endpoint must be a JSON object', json);
  }
  const kind = text(json['bound'], 'a range endpoint`s bound');
  switch (kind) {
    case 'unbounded':
      return { kind: 'unbounded' };
    case 'included':
      return { kind: 'included', value: interpret(json['value'], of, names) };
    case 'excluded':
      return { kind: 'excluded', value: interpret(json['value'], of, names) };
    default:
      refuse('a bound is included, excluded or unbounded', kind);
  }
}

/**
 * Reads one value.
 *
 * `undefined` — the key was not there — is the language's `none`, and that is the
 * one case where absence carries meaning rather than signalling a mistake.
 */
export function interpret(
  json: JsonValue | undefined,
  shape: Shape,
  names?: Names,
): Value {
  if (json === undefined) return { kind: 'none' };

  switch (shape.kind) {
    case 'null':
      if (json !== null) refuse('a null', json);
      return { kind: 'null' };
    case 'bool':
      if (typeof json !== 'boolean') refuse('a bool', json);
      return { kind: 'bool', value: json };
    case 'integer':
      if (typeof json === 'bigint') return { kind: 'integer', value: json };
      if (typeof json !== 'number' || !Number.isInteger(json))
        refuse('an integer', json);
      return { kind: 'integer', value: BigInt(json) };
    case 'decimal':
      return decimal(text(json, 'a decimal'));
    case 'float':
      if (typeof json === 'bigint') return { kind: 'float', value: Number(json) };
      if (typeof json === 'number') return { kind: 'float', value: json };
      // JSON has no spelling for a non-finite, so the surface quotes it.
      if (json === 'inf') return { kind: 'float', value: Number.POSITIVE_INFINITY };
      if (json === '-inf') return { kind: 'float', value: Number.NEGATIVE_INFINITY };
      if (json === 'NaN') return { kind: 'float', value: Number.NaN };
      return refuse('a float', json);
    case 'string':
      return { kind: 'string', value: text(json, 'a string') };
    case 'bytes':
      return { kind: 'bytes', value: hex(text(json, 'bytes'), 'bytes') };
    case 'duration':
      return duration(text(json, 'a duration'));
    case 'datetime':
      return datetime(text(json, 'a datetime'));
    case 'uuid':
      return {
        kind: 'uuid',
        value: hex(text(json, 'a uuid').replaceAll('-', ''), 'a uuid'),
      };
    case 'table':
      return { kind: 'table', id: tableId(text(json, 'a table'), names, 'a table') };
    case 'regex':
      return { kind: 'regex', pattern: text(json, 'a regex') };
    case 'record':
      return record(text(json, 'a record'), shape.id, names);
    case 'array':
    case 'set': {
      if (!Array.isArray(json)) refuse(`a ${shape.kind}`, json);
      // A TessariQL array need not be uniform, so `of` may be one shape for
      // every element or one shape per position. A mixed array with a single
      // shape is a declaration the data does not match, and says so.
      const items = json.map((item, index) => {
        const of = Array.isArray(shape.of) ? shape.of[index] : (shape.of as Shape);
        if (of === undefined) {
          refuse(`a ${shape.kind} carries more elements than the shape declares`, item);
        }
        return interpret(item, of, names);
      });
      return shape.kind === 'array' ? { kind: 'array', items } : { kind: 'set', items };
    }
    case 'object': {
      if (json === null || typeof json !== 'object' || Array.isArray(json))
        refuse('an object', json);
      const fields = new Map<string, Value>();
      // Every declared field is read, including the ones the answer omitted —
      // an omitted field is `none` and dropping it would lose that.
      for (const [field, of] of Object.entries(shape.fields)) {
        fields.set(field, interpret(json[field], of, names));
      }
      return { kind: 'object', fields };
    }
    case 'range': {
      if (json === null || typeof json !== 'object' || Array.isArray(json))
        refuse('a range', json);
      return {
        kind: 'range',
        start: bound(json['start'], shape.of, names),
        end: bound(json['end'], shape.of, names),
      };
    }
    case 'geometry':
      return { kind: 'geometry', shape: readGeometry(json) };
  }
}
