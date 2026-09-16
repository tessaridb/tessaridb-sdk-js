import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Bound,
  Geometry,
  Polygon,
  Position,
  RecordId,
  Value,
} from '../src/value.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The corpus lives in the protocol repository and is not vendored here. It is
 * produced by a second implementation written from the specification alone, which
 * is the entire point: a codec that is wrong in the same way on both sides round
 * trips perfectly, so a suite written alongside this codec cannot catch what the
 * corpus catches.
 */
export function corpusPath(name: string): string {
  const fromEnv = process.env['TESSARI_PROTOCOL_CONFORMANCE'];
  if (fromEnv) return join(fromEnv, name);
  return resolve(here, '..', '..', 'tessaridb-protocol', 'conformance', name);
}

/** A missing corpus fails loudly. A suite that passes having found nothing reports coverage it does not have. */
export function readCorpus(name: string): Record<string, unknown> {
  const path = corpusPath(name);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (why) {
    throw new Error(
      `the conformance corpus is required, not optional.\n` +
        `tried: ${path}\n${String(why)}\n` +
        `set TESSARI_PROTOCOL_CONFORMANCE to the conformance directory`,
    );
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

export function hexToBytes(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new Error(`hex must have an even length: ${text}`);
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The IEEE-754 double whose bits are this hex — never a parsed decimal string. */
function doubleFromBits(hex: string): number {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 8) throw new Error(`a double is 8 bytes, got ${bytes.length}`);
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false);
}

type Json = Record<string, unknown>;

const one = (v: Json): [string, unknown] => {
  const keys = Object.keys(v);
  if (keys.length !== 1) throw new Error(`expected one tag, got ${keys.join(', ')}`);
  return [keys[0]!, v[keys[0]!]];
};

/**
 * Translate the corpus's notation into this client's value model.
 *
 * The translation cannot quietly rescue a broken codec: the corpus's `bytes` are
 * the anchor, so a translation that produces the wrong value produces the wrong
 * bytes and the test fails on the comparison it was going to make anyway.
 */
export function valueOf(json: Json): Value {
  const [tag, body] = one(json);
  switch (tag) {
    case 'none':
      return { kind: 'none' };
    case 'null':
      return { kind: 'null' };
    case 'bool':
      return { kind: 'bool', value: body as boolean };
    case 'integer':
      return { kind: 'integer', value: BigInt(body as string) };
    case 'float_bits':
      return { kind: 'float', value: doubleFromBits(body as string) };
    case 'decimal': {
      const d = body as { mantissa: string; scale: number };
      return { kind: 'decimal', mantissa: BigInt(d.mantissa), scale: d.scale };
    }
    case 'string':
      return { kind: 'string', value: body as string };
    case 'bytes':
      return { kind: 'bytes', value: hexToBytes(body as string) };
    case 'duration': {
      const d = body as { seconds: string; nanos: number };
      return { kind: 'duration', seconds: BigInt(d.seconds), nanos: d.nanos };
    }
    case 'datetime': {
      const d = body as { seconds: string; nanos: number };
      return { kind: 'datetime', seconds: BigInt(d.seconds), nanos: d.nanos };
    }
    case 'uuid':
      return { kind: 'uuid', value: hexToBytes(body as string) };
    case 'table':
      return { kind: 'table', id: body as number };
    case 'record': {
      const r = body as { table: number; id: Json };
      return { kind: 'record', table: r.table, id: recordIdOf(r.id) };
    }
    case 'array':
      return { kind: 'array', items: (body as Json[]).map(valueOf) };
    case 'object': {
      const fields = new Map<string, Value>();
      for (const [name, v] of Object.entries(body as Json))
        fields.set(name, valueOf(v as Json));
      return { kind: 'object', fields };
    }
    case 'set':
      return { kind: 'set', items: (body as Json[]).map(valueOf) };
    case 'range': {
      const r = body as { start: unknown; end: unknown };
      return { kind: 'range', start: boundOf(r.start), end: boundOf(r.end) };
    }
    case 'geometry':
      return { kind: 'geometry', shape: geometryOf(body as Json) };
    case 'regex':
      return { kind: 'regex', pattern: body as string };
    default:
      throw new Error(`the corpus used a value tag this reader does not know: ${tag}`);
  }
}

function recordIdOf(json: Json): RecordId {
  const [tag, body] = one(json);
  switch (tag) {
    case 'int':
      return { kind: 'integer', value: BigInt(body as string) };
    case 'text':
      return { kind: 'text', value: body as string };
    case 'uuid':
      return { kind: 'uuid', value: hexToBytes(body as string) };
    case 'bytes':
      return { kind: 'bytes', value: hexToBytes(body as string) };
    default:
      throw new Error(`unknown record id tag in the corpus: ${tag}`);
  }
}

function boundOf(json: unknown): Bound {
  if (json === 'unbounded') return { kind: 'unbounded' };
  const [tag, body] = one(json as Json);
  if (tag === 'included') return { kind: 'included', value: valueOf(body as Json) };
  if (tag === 'excluded') return { kind: 'excluded', value: valueOf(body as Json) };
  throw new Error(`unknown range bound in the corpus: ${tag}`);
}

function positionOf(json: Json): Position {
  const p = json as unknown as { lon: string; lat: string };
  return { lon: doubleFromBits(p.lon), lat: doubleFromBits(p.lat) };
}

function positionsOf(json: unknown): Position[] {
  return (json as Json[]).map(positionOf);
}

function polygonOf(json: Json): Polygon {
  const p = json as unknown as { exterior: Json[]; interiors?: Json[] };
  return {
    exterior: positionsOf(p.exterior),
    interiors: (p.interiors ?? []).map(positionsOf),
  };
}

function geometryOf(json: Json): Geometry {
  const [tag, body] = one(json);
  switch (tag) {
    case 'point':
      return { kind: 'point', position: positionOf(body as Json) };
    case 'line':
      return { kind: 'line', positions: positionsOf(body) };
    case 'polygon':
      return { kind: 'polygon', polygon: polygonOf(body as Json) };
    case 'multipoint':
      return { kind: 'multipoint', positions: positionsOf(body) };
    case 'multiline':
      return { kind: 'multiline', lines: (body as Json[]).map(positionsOf) };
    case 'multipolygon':
      return { kind: 'multipolygon', polygons: (body as Json[]).map(polygonOf) };
    case 'collection':
      return { kind: 'collection', geometries: (body as Json[]).map(geometryOf) };
    default:
      throw new Error(`unknown geometry kind in the corpus: ${tag}`);
  }
}
