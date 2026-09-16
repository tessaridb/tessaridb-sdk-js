import { ByteReader } from './bytes.ts';
import { ProtocolError } from '../error.ts';
import { BOUND, NANOS_CEILING, NUMBER, RECORD_ID, SHAPE, TAG } from './encode.ts';
import type { Bound, Geometry, Polygon, Position, RecordId, Value } from '../value.ts';

/**
 * Decode one value from a complete payload.
 *
 * The buffer must be **exhausted** afterwards. Bytes remaining are an error and
 * not something to ignore: a value payload carries no length to resume from, so
 * a trailing byte means the decoder and the encoder disagree about the shape, and
 * the next thing read would be read from the wrong place.
 */
export function decodeValue(bytes: Uint8Array): Value {
  const r = new ByteReader(bytes);
  const value = readValue(r);
  if (!r.exhausted) {
    throw new ProtocolError(`${r.remaining} trailing byte(s) after a complete value`);
  }
  return value;
}

export function readValue(r: ByteReader): Value {
  const tag = r.u8('value tag');
  switch (tag) {
    case TAG.none:
      return { kind: 'none' };
    case TAG.null:
      return { kind: 'null' };
    case TAG.bool:
      return { kind: 'bool', value: r.u8('bool') !== 0 };
    case TAG.number:
      return readNumber(r);
    case TAG.string:
      return { kind: 'string', value: r.text('string') };
    case TAG.bytes:
      return { kind: 'bytes', value: r.lenbytes('bytes') };
    case TAG.duration: {
      const seconds = r.i64Inverted('duration seconds');
      return { kind: 'duration', seconds, nanos: readNanos(r, 'duration') };
    }
    case TAG.datetime: {
      const seconds = r.i64Inverted('datetime seconds');
      return { kind: 'datetime', seconds, nanos: readNanos(r, 'datetime') };
    }
    case TAG.uuid:
      return { kind: 'uuid', value: r.fixed(16, 'uuid') };
    case TAG.table:
      return { kind: 'table', id: r.u32('table id') };
    case TAG.record: {
      const table = r.u32('record table id');
      return { kind: 'record', table, id: readRecordId(r) };
    }
    case TAG.array:
      return { kind: 'array', items: readValues(r, 'array') };
    case TAG.object: {
      const count = r.u32('object field count');
      const fields = new Map<string, Value>();
      for (let i = 0; i < count; i++) {
        const name = r.text('object field name');
        fields.set(name, readValue(r));
      }
      return { kind: 'object', fields };
    }
    case TAG.set:
      return { kind: 'set', items: readValues(r, 'set') };
    case TAG.range: {
      const start = readBound(r);
      return { kind: 'range', start, end: readBound(r) };
    }
    case TAG.geometry:
      return { kind: 'geometry', shape: readGeometry(r) };
    case TAG.regex:
      return { kind: 'regex', pattern: r.text('regex pattern') };
    default:
      // Never a guess. A codec that infers the type from what follows reads a
      // newer format as a plausible wrong value, and nothing downstream can tell.
      throw new ProtocolError(`unknown value tag 0x${hex(tag)}`);
  }
}

function readValues(r: ByteReader, what: string): Value[] {
  const count = r.u32(`${what} count`);
  const items: Value[] = [];
  for (let i = 0; i < count; i++) items.push(readValue(r));
  return items;
}

function readNumber(r: ByteReader): Value {
  const kind = r.u8('number kind');
  switch (kind) {
    case NUMBER.integer:
      return { kind: 'integer', value: r.i64Inverted('integer') };
    case NUMBER.float:
      return { kind: 'float', value: r.f64Bits('float') };
    case NUMBER.decimal: {
      const mantissa = r.i128('decimal mantissa');
      return { kind: 'decimal', mantissa, scale: r.u32('decimal scale') };
    }
    default:
      throw new ProtocolError(`unknown number kind 0x${hex(kind)}`);
  }
}

function readNanos(r: ByteReader, what: string): number {
  const nanos = r.u32(`${what} nanoseconds`);
  if (nanos >= NANOS_CEILING) {
    throw new ProtocolError(
      `${what} nanoseconds ${nanos} is outside 0..${NANOS_CEILING - 1}`,
    );
  }
  return nanos;
}

function readRecordId(r: ByteReader): RecordId {
  const tag = r.u8('record id tag');
  switch (tag) {
    case RECORD_ID.integer:
      return { kind: 'integer', value: r.i64Inverted('record id integer') };
    case RECORD_ID.text: {
      const bytes = r.varbytes('record id text');
      try {
        return {
          kind: 'text',
          value: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        };
      } catch {
        throw new ProtocolError('invalid UTF-8 in record id text');
      }
    }
    case RECORD_ID.uuid:
      return { kind: 'uuid', value: r.fixed(16, 'record id uuid') };
    case RECORD_ID.bytes:
      return { kind: 'bytes', value: r.varbytes('record id bytes') };
    default:
      throw new ProtocolError(`unknown record id tag 0x${hex(tag)}`);
  }
}

function readBound(r: ByteReader): Bound {
  const tag = r.u8('range bound kind');
  switch (tag) {
    case BOUND.unbounded:
      return { kind: 'unbounded' };
    case BOUND.included:
      return { kind: 'included', value: readValue(r) };
    case BOUND.excluded:
      return { kind: 'excluded', value: readValue(r) };
    default:
      throw new ProtocolError(`unknown range bound kind 0x${hex(tag)}`);
  }
}

function readPosition(r: ByteReader): Position {
  const lon = r.f64Bits('longitude');
  return { lon, lat: r.f64Bits('latitude') };
}

function readPositions(r: ByteReader, what: string): Position[] {
  const count = r.u32(`${what} position count`);
  const ps: Position[] = [];
  for (let i = 0; i < count; i++) ps.push(readPosition(r));
  return ps;
}

function readPolygon(r: ByteReader): Polygon {
  const exterior = readPositions(r, 'polygon exterior ring');
  const holes = r.u32('polygon interior ring count');
  const interiors: Position[][] = [];
  for (let i = 0; i < holes; i++)
    interiors.push(readPositions(r, 'polygon interior ring'));
  return { exterior, interiors };
}

/**
 * Validity is not enforced here. A ring that does not close, a coordinate off the
 * sphere and a line with one position all decode: the decoder reports what the
 * bytes said, and the node applies its own checks on acceptance. A client that
 * refuses locally what the node would accept has invented a second rule.
 */
function readGeometry(r: ByteReader): Geometry {
  const kind = r.u8('geometry kind');
  switch (kind) {
    case SHAPE.point:
      return { kind: 'point', position: readPosition(r) };
    case SHAPE.line:
      return { kind: 'line', positions: readPositions(r, 'line') };
    case SHAPE.polygon:
      return { kind: 'polygon', polygon: readPolygon(r) };
    case SHAPE.multipoint:
      return { kind: 'multipoint', positions: readPositions(r, 'multipoint') };
    case SHAPE.multiline: {
      const count = r.u32('multiline count');
      const lines: Position[][] = [];
      for (let i = 0; i < count; i++) lines.push(readPositions(r, 'multiline line'));
      return { kind: 'multiline', lines };
    }
    case SHAPE.multipolygon: {
      const count = r.u32('multipolygon count');
      const polygons: Polygon[] = [];
      for (let i = 0; i < count; i++) polygons.push(readPolygon(r));
      return { kind: 'multipolygon', polygons };
    }
    case SHAPE.collection: {
      const count = r.u32('geometry collection count');
      const geometries: Geometry[] = [];
      for (let i = 0; i < count; i++) geometries.push(readGeometry(r));
      return { kind: 'collection', geometries };
    }
    default:
      throw new ProtocolError(`unknown geometry kind 0x${hex(kind)}`);
  }
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}
