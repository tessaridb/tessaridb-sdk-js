/**
 * The text-level rules the query builder is built on: what a name is, what a
 * count is, and how a value becomes a parameter reference.
 *
 * The rendering contract's one guarantee is that a caller's value never reaches
 * the statement text (§2). Everything here exists to hold that line: names are
 * checked in front of the interpolation that uses them, counts are integers
 * before they are digits, and values only ever leave through the binder.
 */

import type { Value } from '../value.ts';

/** The reasons a builder reports. The contract names these and no others. */
export type RefusalReason =
  'not-a-name' | 'incomplete' | 'not-a-span' | 'not-an-answerer';

/** Which grammatical position was at fault. The contract's own wording. */
export type NamePosition = 'a table' | 'a field';

/**
 * The builder declined to render.
 *
 * A refusal is returned to the caller rather than rendered into a statement the
 * node will refuse instead — the caller is here now and the node is not.
 */
export class BuilderError extends Error {
  override readonly name = 'BuilderError';
  readonly reason: RefusalReason;
  /** For `not-a-name`: which position. Undefined for `incomplete`. */
  readonly position: NamePosition | undefined;
  /** For `not-a-name`: the string that was not a name. */
  readonly offending: string | undefined;

  private constructor(
    message: string,
    reason: RefusalReason,
    position: NamePosition | undefined,
    offending: string | undefined,
  ) {
    super(message);
    this.reason = reason;
    this.position = position;
    this.offending = offending;
  }

  static notAName(position: NamePosition, offending: string): BuilderError {
    return new BuilderError(
      `${position} was given ${JSON.stringify(offending)}, which is not a name`,
      'not-a-name',
      position,
      offending,
    );
  }

  static incomplete(message: string): BuilderError {
    return new BuilderError(message, 'incomplete', undefined, undefined);
  }

  static notASpan(offending: string): BuilderError {
    return new BuilderError(
      `${JSON.stringify(offending)} is not a span — write digits and one of ` +
        'ns, us, ms, s, m, h, d, w, as in "30s" or "1m30s"',
      'not-a-span',
      undefined,
      offending,
    );
  }

  static notAnAnswerer(offending: string): BuilderError {
    return new BuilderError(
      `${JSON.stringify(offending)} is not an answerer — write ANY or LEADER`,
      'not-an-answerer',
      undefined,
      offending,
    );
  }
}

/** The node's own eight units, longest first so `ms` is read before `m`. */
const SPAN_UNITS = ['ms', 'ns', 'us', 's', 'm', 'h', 'd', 'w'] as const;

/**
 * span ::= 1*( 1*DIGIT unit ), with the units above.
 *
 * Checked because a span is written into the statement TEXT rather than bound —
 * a node refuses a parameter in that position — so this is the one clause where
 * a caller's characters reach the script.
 *
 * The VALUE is never judged here. A bound tighter than the cluster's floor is the
 * node's refusal to make, and its message names the floor; a client that guessed
 * would be wrong on the next cluster.
 */
export function span(text: string): string {
  let rest = text;
  let seen = false;
  while (rest.length > 0) {
    let digits = 0;
    while (digits < rest.length && rest[digits]! >= '0' && rest[digits]! <= '9') {
      digits += 1;
    }
    if (digits === 0) {
      throw BuilderError.notASpan(text);
    }
    rest = rest.slice(digits);
    const unit = SPAN_UNITS.find((candidate) => rest.startsWith(candidate));
    if (unit === undefined) {
      throw BuilderError.notASpan(text);
    }
    rest = rest.slice(unit.length);
    seen = true;
  }
  if (!seen) {
    throw BuilderError.notASpan(text);
  }
  return text;
}

/** `ANY` or `LEADER`, and no third. */
export function answerer(word: string): string {
  if (word !== 'ANY' && word !== 'LEADER') {
    throw BuilderError.notAnAnswerer(word);
  }
  return word;
}

/**
 * name ::= ( ALPHA / "_" ) *( ALPHA / DIGIT / "_" ), ASCII letters only.
 *
 * Deliberately narrower than what the node's lexer accepts. A guard that reasons
 * about what a lexer would do has to be re-checked every time the lexer changes;
 * this one does not.
 *
 * `$` here anchors at the end of the string and nowhere else — JavaScript, unlike
 * the language the corpus generator is written in, does not let it match before a
 * trailing newline. That difference is the whole guard on a name ending in one.
 */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns the name, or refuses.
 *
 * It never quotes or escapes a string into acceptance: quoting turns a caller's
 * mistake into a statement that runs and means something else.
 */
export function name(position: NamePosition, value: string): string {
  if (!NAME.test(value)) {
    throw BuilderError.notAName(position, value);
  }
  return value;
}

const U64_CEILING = 0xffff_ffff_ffff_ffffn;

/**
 * A count — `START`, `LIMIT`, and a line window's two numbers — rendered as
 * decimal digits.
 *
 * These are part of the statement's shape rather than data, which is why they are
 * written literally rather than bound. That is safe because a builder receives
 * them as integers, so there is nothing a caller can smuggle syntax through, and
 * this function is where "receives them as integers" is actually enforced:
 * `BigInt` rejects a fraction and a `NaN` outright.
 */
export function count(n: number | bigint): string {
  const value = typeof n === 'bigint' ? n : BigInt(n);
  if (value < 0n || value > U64_CEILING) {
    throw new RangeError(`a count must fit an unsigned 64-bit integer, got ${value}`);
  }
  return value.toString();
}

/**
 * Hands out `$p0`, `$p1`, … in binding order and keeps what each one stands for.
 *
 * The counter is per statement, and binding order is the order a reader of the
 * rendered text meets the references left to right — so every caller of `bind`
 * must be rendering the text at that moment, not collecting values to render
 * later.
 */
export class Binder {
  readonly parameters = new Map<string, Value>();

  bind(value: Value): string {
    const reference = `p${this.parameters.size}`;
    this.parameters.set(reference, value);
    return `$${reference}`;
  }
}

/** A rendered statement and the values its references stand for. */
export interface Rendered {
  readonly script: string;
  readonly parameters: Map<string, Value>;
}
