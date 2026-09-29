/**
 * A batch of events as `POST /series` reads it (§5.9).
 *
 * The body is one TessariQL value — an array of objects of literals — so each
 * value is rendered as TessariQL source, which §5.9 makes this client's job. The
 * kinds an event needs each have one spelling; every other kind is refused here,
 * before a byte is sent, rather than approximated into a value nobody meant.
 */

import type { Value } from '../value.ts';

/** A batch holds something an event cannot carry; nothing was sent. */
export class NotAnEventError extends Error {
  constructor(reason: string) {
    super(`not an event: ${reason}`);
    this.name = 'NotAnEventError';
  }
}

/** The body: one TessariQL array of the events. */
export function batch(events: readonly Value[]): string {
  return `[${events
    .map((event) => {
      if (event.kind !== 'object') throw new NotAnEventError('an event is an object');
      return literal(event);
    })
    .join(', ')}]`;
}

/** One value, spelled as §5.9 spells it. */
export function literal(value: Value): string {
  switch (value.kind) {
    case 'null':
      return 'NULL';
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'integer':
      return value.value.toString();
    case 'float': {
      if (!Number.isFinite(value.value))
        throw new NotAnEventError('a float that is not finite has no spelling');
      // A float must carry a `.` or an exponent, or it reads as an integer.
      const text = String(value.value);
      return /[.e]/.test(text) ? text : `${text}.0`;
    }
    case 'decimal':
      return decimal(value.mantissa, value.scale);
    case 'string':
      return quoted(value.value);
    case 'datetime':
      return `datetime '${instant(value.seconds, value.nanos)}'`;
    case 'uuid': {
      const hex = Array.from(value.value, (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return `uuid '${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}'`;
    }
    case 'array':
      return `[${value.items
        .map((item) => {
          if (item.kind === 'none')
            throw new NotAnEventError('an array cannot hold an absence');
          return literal(item);
        })
        .join(', ')}]`;
    case 'object': {
      // A field holding none is left out, which is what absence means.
      const fields = [...value.fields]
        .filter(([, held]) => held.kind !== 'none')
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, held]) => `${quoted(name)}: ${literal(held)}`);
      return fields.length === 0 ? '{}' : `{ ${fields.join(', ')} }`;
    }
    default:
      throw new NotAnEventError(
        'an event carries null, booleans, numbers, strings, datetimes, uuids, arrays and objects',
      );
  }
}

function quoted(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function decimal(mantissa: bigint, scale: number): string {
  const sign = mantissa < 0n ? '-' : '';
  const digits = (mantissa < 0n ? -mantissa : mantissa).toString();
  if (scale === 0) return `dec ${sign}${digits}`;
  const padded = digits.padStart(scale + 1, '0');
  return `dec ${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function instant(seconds: bigint, nanos: number): string {
  const millis = Number(seconds) * 1000;
  const moment = new Date(millis);
  if (
    Number.isNaN(moment.getTime()) ||
    moment.getUTCFullYear() < 0 ||
    moment.getUTCFullYear() > 9999
  )
    throw new NotAnEventError('a datetime outside the years 0 to 9999');
  const whole = moment.toISOString().slice(0, 19);
  return nanos > 0 ? `${whole}.${nanos.toString().padStart(9, '0')}Z` : `${whole}Z`;
}
