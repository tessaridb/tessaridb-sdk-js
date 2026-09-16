/**
 * GeoJSON, as §5.7 renders a geometry on the HTTP surface.
 *
 * Two rules carry the whole module. Coordinates are **`[longitude, latitude]`**
 * (RFC 7946 §3.1.1) — the opposite order is the most common bug in geospatial
 * code precisely because it is silent, and a point in Paris becomes a point in
 * the Indian Ocean, which is a perfectly valid place. And a non-finite coordinate
 * is written `null`, because JSON has no spelling for one; it reads back as
 * `NaN`, which is the only non-finite a `null` can honestly become.
 */

import type { Geometry, Polygon, Position, Ring } from '../value.ts';
import type { JsonValue } from './json.ts';

export class GeoJsonError extends Error {
  override readonly name = 'GeoJsonError';
}

function object(json: JsonValue, what: string): { [key: string]: JsonValue } {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new GeoJsonError(`${what} must be a JSON object`);
  }
  return json;
}

function array(json: JsonValue | undefined, what: string): JsonValue[] {
  if (!Array.isArray(json)) throw new GeoJsonError(`${what} must be a JSON array`);
  return json;
}

/** A coordinate. `null` is the surface's spelling for a non-finite one. */
function coordinate(json: JsonValue | undefined): number {
  if (json === null) return Number.NaN;
  if (typeof json === 'number') return json;
  if (typeof json === 'bigint') return Number(json);
  throw new GeoJsonError('a coordinate must be a number or null');
}

function position(json: JsonValue | undefined): Position {
  const pair = array(json, 'a position');
  if (pair.length < 2)
    throw new GeoJsonError('a position needs a longitude and a latitude');
  // Altitude is not carried by this protocol, so a third element is ignored
  // rather than refused — RFC 7946 permits one and the store simply has no slot.
  return { lon: coordinate(pair[0]), lat: coordinate(pair[1]) };
}

function ring(json: JsonValue | undefined): Ring {
  return array(json, 'a ring').map(position);
}

function polygon(json: JsonValue | undefined): Polygon {
  const rings = array(json, 'a polygon');
  const [exterior, ...interiors] = rings;
  if (exterior === undefined)
    throw new GeoJsonError('a polygon needs an exterior ring');
  return { exterior: ring(exterior), interiors: interiors.map(ring) };
}

/**
 * Reads one GeoJSON object.
 *
 * Validity is not enforced — a ring that does not close, a polygon whose hole
 * escapes it. The surface reports what the store holds, and a reader that
 * rejected it would be answering a question the store already answered.
 */
export function readGeometry(json: JsonValue): Geometry {
  const shape = object(json, 'a geometry');
  const type = shape['type'];
  if (typeof type !== 'string')
    throw new GeoJsonError('a geometry needs a string `type`');

  switch (type) {
    case 'Point':
      return { kind: 'point', position: position(shape['coordinates']) };
    case 'LineString':
      return {
        kind: 'line',
        positions: array(shape['coordinates'], 'a line').map(position),
      };
    case 'Polygon':
      return { kind: 'polygon', polygon: polygon(shape['coordinates']) };
    case 'MultiPoint':
      return {
        kind: 'multipoint',
        positions: array(shape['coordinates'], 'a multipoint').map(position),
      };
    case 'MultiLineString':
      return {
        kind: 'multiline',
        lines: array(shape['coordinates'], 'a multiline').map(ring),
      };
    case 'MultiPolygon':
      return {
        kind: 'multipolygon',
        polygons: array(shape['coordinates'], 'a multipolygon').map(polygon),
      };
    case 'GeometryCollection':
      return {
        kind: 'collection',
        geometries: array(shape['geometries'], 'a geometry collection').map(
          readGeometry,
        ),
      };
    default:
      // A type this build does not know is an error rather than a guess: the
      // store has seven kinds and an eighth would be a protocol change.
      throw new GeoJsonError(`unknown geometry type ${JSON.stringify(type)}`);
  }
}
