import { ByteWriter } from '../codec/bytes.ts';
import { ProtocolError } from '../error.ts';

/**
 * Frame kinds. Numbered explicitly and **never renumbered** — a byte that once
 * meant one thing cannot be asked about after the fact by a client of a different
 * build.
 *
 * Tags 6 through 12 belong to the link nodes use to talk to each other. A client
 * never sends one and never receives one. That the client's tags are low and
 * contiguous describes today's arrangement and is never the property relied on:
 * a tag is checked against the kinds this build knows, never against a range.
 */
export const FRAME = {
  request: 1,
  answer: 2,
  refusal: 3,
  subscribe: 4,
  change: 5,
  elsewhere: 13,
} as const;

/** `kind` 1 byte + `length` 4 bytes big-endian. */
export const HEADER_BYTES = 5;

/**
 * 16 MiB, and it applies **on the way out as well as in**. A length from a
 * stranger is not a promise, and allocating on one is the oldest denial of
 * service there is; a peer that emits what it would refuse to read is running two
 * protocols.
 */
export const CEILING = 16 * 1024 * 1024;

export class TooLargeError extends Error {
  override readonly name = 'TooLargeError';
  readonly length: number;

  constructor(length: number) {
    super(`frame body of ${length} bytes exceeds the ${CEILING}-byte ceiling`);
    this.length = length;
  }
}

/** A frame kind this build does not know. The connection closes; it is never skipped. */
export class UnknownFrameError extends Error {
  override readonly name = 'UnknownFrameError';
  readonly tag: number;

  constructor(tag: number) {
    super(`unknown frame kind ${tag}`);
    this.tag = tag;
  }
}

export function frame(kind: number, body: Uint8Array): Uint8Array {
  if (body.length > CEILING) throw new TooLargeError(body.length);
  const w = new ByteWriter(HEADER_BYTES + body.length);
  w.u8(kind);
  w.u32(body.length);
  w.fixed(body);
  return w.finish();
}

export interface FrameHeader {
  kind: number;
  length: number;
}

/** Refuses an over-ceiling length **before anything is allocated**. */
export function readHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.length < HEADER_BYTES) {
    throw new ProtocolError(
      `a frame header is ${HEADER_BYTES} bytes, got ${bytes.length}`,
    );
  }
  const kind = bytes[0]!;
  const length =
    ((bytes[1]! << 24) | (bytes[2]! << 16) | (bytes[3]! << 8) | bytes[4]!) >>> 0;
  if (length > CEILING) throw new TooLargeError(length);
  return { kind, length };
}

/** The six bytes both sides send on connect, before anything else. */
export const MAGIC = Uint8Array.from([0x54, 0x45, 0x53, 0x53]); // "TESS"
export const MAJOR = 1;
export const MINOR = 1;
export const GREETING_BYTES = 6;

export function greeting(): Uint8Array {
  return Uint8Array.from([...MAGIC, MAJOR, MINOR]);
}
