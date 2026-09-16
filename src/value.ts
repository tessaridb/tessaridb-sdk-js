/**
 * The store's value model — seventeen types, and the distinctions between them
 * are load-bearing.
 *
 * Two of those distinctions disappear in every JSON-shaped client and are kept
 * here deliberately. `none` and `null` are different: the field is not present,
 * versus the field is present and holds nothing. And an integer is an `i64`, not
 * a double, so it is carried as a `bigint` — a JavaScript number silently loses
 * precision above 2^53, which is well inside the range the store accepts.
 *
 * Floating point is carried as a `number` because the bits of a JS double are the
 * bits the protocol asks for: `-0` survives, and so does the canonical quiet NaN.
 * The one thing a `number` cannot hold is a NaN with a non-canonical payload —
 * JavaScript normalises it — so such a value decodes to `NaN` and re-encodes to
 * the canonical pattern. No node emits one, and saying so is better than pretending
 * the round trip is total.
 */

export type Value =
  | { kind: 'none' }
  | { kind: 'null' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'integer'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'decimal'; mantissa: bigint; scale: number }
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'duration'; seconds: bigint; nanos: number }
  | { kind: 'datetime'; seconds: bigint; nanos: number }
  | { kind: 'uuid'; value: Uint8Array }
  | { kind: 'table'; id: number }
  | { kind: 'record'; table: number; id: RecordId }
  | { kind: 'array'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> }
  | { kind: 'set'; items: Value[] }
  | { kind: 'range'; start: Bound; end: Bound }
  | { kind: 'geometry'; shape: Geometry }
  | { kind: 'regex'; pattern: string };

/** A record's identity within its table. The four variants are fixed forever. */
export type RecordId =
  | { kind: 'integer'; value: bigint }
  | { kind: 'text'; value: string }
  | { kind: 'uuid'; value: Uint8Array }
  | { kind: 'bytes'; value: Uint8Array };

/** One end of a range. Either end may itself hold a range. */
export type Bound =
  | { kind: 'unbounded' }
  | { kind: 'included'; value: Value }
  | { kind: 'excluded'; value: Value };

/**
 * A position on the sphere. **Longitude first** — RFC 7946 §3.1.1 fixes it, and
 * the opposite order is the most common bug in geospatial code precisely because
 * it is silent: a point in Paris becomes a point in the Indian Ocean, which is a
 * perfectly valid place.
 *
 * Altitude is not carried by the protocol.
 */
export interface Position {
  lon: number;
  lat: number;
}

/** A ring of positions. The codec does not require it to close. */
export type Ring = Position[];

/** An exterior ring and its holes. */
export interface Polygon {
  exterior: Ring;
  interiors: Ring[];
}

export type Geometry =
  | { kind: 'point'; position: Position }
  | { kind: 'line'; positions: Position[] }
  | { kind: 'polygon'; polygon: Polygon }
  | { kind: 'multipoint'; positions: Position[] }
  | { kind: 'multiline'; lines: Position[][] }
  | { kind: 'multipolygon'; polygons: Polygon[] }
  | { kind: 'collection'; geometries: Geometry[] };
