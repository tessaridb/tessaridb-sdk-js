import { ByteWriter } from './bytes.ts';
import { ProtocolError } from '../error.ts';
import type { Bound, Geometry, Polygon, Position, RecordId, Value } from '../value.ts';

/** Type tags. Permanent — a tag is never reused and never renumbered. */
const TAG = {
  none: 0x01,
  null: 0x02,
  bool: 0x03,
  number: 0x04,
  string: 0x05,
  bytes: 0x06,
  duration: 0x07,
  datetime: 0x08,
  uuid: 0x09,
  table: 0x0a,
  record: 0x0b,
  array: 0x0c,
  object: 0x0d,
  range: 0x0e,
  set: 0x0f,
  geometry: 0x10,
  regex: 0x11,
} as const;

const NUMBER = { integer: 0x01, float: 0x02, decimal: 0x03 } as const;
const BOUND = { unbounded: 0x01, included: 0x02, excluded: 0x03 } as const;
const RECORD_ID = { integer: 0x01, text: 0x02, uuid: 0x03, bytes: 0x04 } as const;
const SHAPE = {
  point: 0x01,
  line: 0x02,
  polygon: 0x03,
  multipoint: 0x04,
  multiline: 0x05,
  multipolygon: 0x06,
  collection: 0x07,
} as const;

const NANOS_CEILING = 1_000_000_000;

export function encodeValue(value: Value): Uint8Array {
  const w = new ByteWriter();
  writeValue(w, value);
  return w.finish();
}

export function writeValue(w: ByteWriter, value: Value): void {
  switch (value.kind) {
    case 'none':
      w.u8(TAG.none);
      return;
    case 'null':
      w.u8(TAG.null);
      return;
    case 'bool':
      w.u8(TAG.bool);
      w.u8(value.value ? 1 : 0);
      return;
    case 'integer':
      w.u8(TAG.number);
      w.u8(NUMBER.integer);
      w.i64Inverted(value.value);
      return;
    case 'float':
      w.u8(TAG.number);
      w.u8(NUMBER.float);
      w.f64Bits(value.value);
      return;
    case 'decimal':
      w.u8(TAG.number);
      w.u8(NUMBER.decimal);
      w.i128(value.mantissa);
      w.u32(value.scale);
      return;
    case 'string':
      w.u8(TAG.string);
      w.text(value.value);
      return;
    case 'bytes':
      w.u8(TAG.bytes);
      w.lenbytes(value.value);
      return;
    case 'duration':
      w.u8(TAG.duration);
      writeSecondsAndNanos(w, value.seconds, value.nanos, 'duration');
      return;
    case 'datetime':
      w.u8(TAG.datetime);
      writeSecondsAndNanos(w, value.seconds, value.nanos, 'datetime');
      return;
    case 'uuid':
      w.u8(TAG.uuid);
      writeFixedWidth(w, value.value, 16, 'uuid');
      return;
    case 'table':
      w.u8(TAG.table);
      w.u32(value.id);
      return;
    case 'record':
      w.u8(TAG.record);
      w.u32(value.table);
      writeRecordId(w, value.id);
      return;
    case 'array':
      w.u8(TAG.array);
      w.u32(value.items.length);
      for (const item of value.items) writeValue(w, item);
      return;
    case 'object': {
      w.u8(TAG.object);
      w.u32(value.fields.size);
      // Name order is a client-side convenience, not a protocol requirement: the
      // node re-normalises on decode. Emitting it sorted is what makes two equal
      // values encode to equal bytes, which is what lets a caller compare or
      // cache encodings of its own.
      const names = [...value.fields.keys()].sort();
      for (const name of names) {
        w.text(name);
        writeValue(w, value.fields.get(name)!);
      }
      return;
    }
    case 'set':
      w.u8(TAG.set);
      w.u32(value.items.length);
      for (const item of value.items) writeValue(w, item);
      return;
    case 'range':
      w.u8(TAG.range);
      writeBound(w, value.start);
      writeBound(w, value.end);
      return;
    case 'geometry':
      w.u8(TAG.geometry);
      writeGeometry(w, value.shape);
      return;
    case 'regex':
      // Carried as written and uncompiled. A client that compiles it to check
      // validity rejects patterns the node would have accepted, because dialects
      // disagree about what is valid.
      w.u8(TAG.regex);
      w.text(value.pattern);
      return;
  }
}

function writeSecondsAndNanos(
  w: ByteWriter,
  seconds: bigint,
  nanos: number,
  what: string,
): void {
  if (!Number.isInteger(nanos) || nanos < 0 || nanos >= NANOS_CEILING) {
    throw new ProtocolError(
      `${what} nanoseconds ${nanos} is outside 0..${NANOS_CEILING - 1}`,
    );
  }
  w.i64Inverted(seconds);
  w.u32(nanos);
}

function writeFixedWidth(
  w: ByteWriter,
  bytes: Uint8Array,
  width: number,
  what: string,
): void {
  if (bytes.length !== width) {
    throw new ProtocolError(`${what} must be ${width} bytes, got ${bytes.length}`);
  }
  w.fixed(bytes);
}

function writeRecordId(w: ByteWriter, id: RecordId): void {
  switch (id.kind) {
    case 'integer':
      w.u8(RECORD_ID.integer);
      w.i64Inverted(id.value);
      return;
    case 'text':
      w.u8(RECORD_ID.text);
      w.varbytes(new TextEncoder().encode(id.value));
      return;
    case 'uuid':
      w.u8(RECORD_ID.uuid);
      writeFixedWidth(w, id.value, 16, 'record id uuid');
      return;
    case 'bytes':
      w.u8(RECORD_ID.bytes);
      w.varbytes(id.value);
      return;
  }
}

function writeBound(w: ByteWriter, bound: Bound): void {
  switch (bound.kind) {
    case 'unbounded':
      w.u8(BOUND.unbounded);
      return;
    case 'included':
      w.u8(BOUND.included);
      writeValue(w, bound.value);
      return;
    case 'excluded':
      w.u8(BOUND.excluded);
      writeValue(w, bound.value);
      return;
  }
}

/** Longitude first, and the coordinates are bits rather than text. */
function writePosition(w: ByteWriter, p: Position): void {
  w.f64Bits(p.lon);
  w.f64Bits(p.lat);
}

function writePositions(w: ByteWriter, ps: Position[]): void {
  w.u32(ps.length);
  for (const p of ps) writePosition(w, p);
}

function writePolygon(w: ByteWriter, polygon: Polygon): void {
  writePositions(w, polygon.exterior);
  w.u32(polygon.interiors.length);
  for (const ring of polygon.interiors) writePositions(w, ring);
}

function writeGeometry(w: ByteWriter, shape: Geometry): void {
  switch (shape.kind) {
    case 'point':
      w.u8(SHAPE.point);
      writePosition(w, shape.position);
      return;
    case 'line':
      w.u8(SHAPE.line);
      writePositions(w, shape.positions);
      return;
    case 'polygon':
      w.u8(SHAPE.polygon);
      writePolygon(w, shape.polygon);
      return;
    case 'multipoint':
      w.u8(SHAPE.multipoint);
      writePositions(w, shape.positions);
      return;
    case 'multiline':
      w.u8(SHAPE.multiline);
      w.u32(shape.lines.length);
      for (const line of shape.lines) writePositions(w, line);
      return;
    case 'multipolygon':
      w.u8(SHAPE.multipolygon);
      w.u32(shape.polygons.length);
      for (const polygon of shape.polygons) writePolygon(w, polygon);
      return;
    case 'collection':
      w.u8(SHAPE.collection);
      w.u32(shape.geometries.length);
      for (const g of shape.geometries) writeGeometry(w, g);
      return;
  }
}

export { TAG, NUMBER, BOUND, RECORD_ID, SHAPE, NANOS_CEILING };
