import { ProtocolError } from '../error.ts';

/**
 * The two primitive sets, and the one detail that decides whether this client
 * works at all.
 *
 * The protocol has two layers with different integer encodings, and conflating
 * them does not fail to parse — it returns wrong values. The frame layer writes
 * plain big-endian. The value layer writes an `i64` **with the top bit of the
 * first byte inverted**, because those primitives are shared with an
 * order-preserving key encoder where a set sign bit would sort negatives above
 * positives.
 *
 * So `1` encodes as `80 00 00 00 00 00 00 01`, not `00 ... 01`. A client that
 * writes plain big-endian here gets every integer, duration, datetime and integer
 * record id wrong, and round-trips them perfectly against itself.
 */

const INVERSION = 0x80;

export class ByteWriter {
  #buf: Uint8Array;
  #len: number;

  constructor(capacity = 256) {
    this.#buf = new Uint8Array(capacity);
    this.#len = 0;
  }

  #reserve(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  u8(n: number): void {
    this.#reserve(1);
    this.#buf[this.#len++] = n & 0xff;
  }

  /** Plain big-endian. Used by both layers. */
  u32(n: number): void {
    this.#reserve(4);
    this.#buf[this.#len++] = (n >>> 24) & 0xff;
    this.#buf[this.#len++] = (n >>> 16) & 0xff;
    this.#buf[this.#len++] = (n >>> 8) & 0xff;
    this.#buf[this.#len++] = n & 0xff;
  }

  /** Plain big-endian. Frame layer only — the value layer never writes one. */
  u64(n: bigint): void {
    this.#reserve(8);
    let x = BigInt.asUintN(64, n);
    for (let i = 7; i >= 0; i--) {
      this.#buf[this.#len + i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.#len += 8;
  }

  /** Value layer. Two's-complement big-endian with the first byte's top bit flipped. */
  i64Inverted(n: bigint): void {
    this.#reserve(8);
    let x = BigInt.asUintN(64, n);
    for (let i = 7; i >= 0; i--) {
      this.#buf[this.#len + i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.#buf[this.#len]! ^= INVERSION;
    this.#len += 8;
  }

  /** The eight bytes of an IEEE-754 double, plain big-endian. Never inverted. */
  f64Bits(n: number): void {
    this.#reserve(8);
    new DataView(this.#buf.buffer, this.#buf.byteOffset + this.#len, 8).setFloat64(
      0,
      n,
      false,
    );
    this.#len += 8;
  }

  /** An `i128`, plain big-endian. Only a decimal mantissa uses it. */
  i128(n: bigint): void {
    this.#reserve(16);
    let x = BigInt.asUintN(128, n);
    for (let i = 15; i >= 0; i--) {
      this.#buf[this.#len + i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.#len += 16;
  }

  /** `n` bytes verbatim; the width is implied by what precedes. */
  fixed(bytes: Uint8Array): void {
    this.#reserve(bytes.length);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.length;
  }

  /** `u32` length, then the bytes. Spelled `bytes` at the frame layer, `lenbytes` at the value layer. */
  lenbytes(bytes: Uint8Array): void {
    this.u32(bytes.length);
    this.fixed(bytes);
  }

  /** `u32` byte-length, then UTF-8. Not NUL-terminated. */
  text(s: string): void {
    this.lenbytes(new TextEncoder().encode(s));
  }

  /**
   * Escaped and terminated: `0x00` becomes `0x00 0xFF`, then `0x00 0x01` ends it.
   *
   * The escape is byte-local, which is what makes the encoding of a prefix a byte
   * prefix of the encoding of the whole — the property the key encoder needs.
   */
  varbytes(bytes: Uint8Array): void {
    this.#reserve(bytes.length + 2);
    for (const b of bytes) {
      this.u8(b);
      if (b === 0x00) this.u8(0xff);
    }
    this.u8(0x00);
    this.u8(0x01);
  }

  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

export class ByteReader {
  #bytes: Uint8Array;
  #at: number;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#at = 0;
  }

  get remaining(): number {
    return this.#bytes.length - this.#at;
  }

  get exhausted(): boolean {
    return this.#at >= this.#bytes.length;
  }

  #need(n: number, what: string): void {
    if (this.remaining < n) {
      throw new ProtocolError(
        `truncated while reading ${what}: wanted ${n} byte(s), ${this.remaining} left`,
      );
    }
  }

  u8(what = 'u8'): number {
    this.#need(1, what);
    return this.#bytes[this.#at++]!;
  }

  u32(what = 'u32'): number {
    this.#need(4, what);
    const b = this.#bytes;
    const at = this.#at;
    this.#at += 4;
    return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
  }

  u64(what = 'u64'): bigint {
    this.#need(8, what);
    let x = 0n;
    for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(this.#bytes[this.#at + i]!);
    this.#at += 8;
    return x;
  }

  i64Inverted(what = 'i64'): bigint {
    this.#need(8, what);
    let x = BigInt(this.#bytes[this.#at]! ^ INVERSION);
    for (let i = 1; i < 8; i++) x = (x << 8n) | BigInt(this.#bytes[this.#at + i]!);
    this.#at += 8;
    return BigInt.asIntN(64, x);
  }

  f64Bits(what = 'f64'): number {
    this.#need(8, what);
    const v = new DataView(
      this.#bytes.buffer,
      this.#bytes.byteOffset + this.#at,
      8,
    ).getFloat64(0, false);
    this.#at += 8;
    return v;
  }

  i128(what = 'i128'): bigint {
    this.#need(16, what);
    let x = 0n;
    for (let i = 0; i < 16; i++) x = (x << 8n) | BigInt(this.#bytes[this.#at + i]!);
    this.#at += 16;
    return BigInt.asIntN(128, x);
  }

  fixed(n: number, what = 'fixed'): Uint8Array {
    this.#need(n, what);
    const out = this.#bytes.slice(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }

  lenbytes(what = 'lenbytes'): Uint8Array {
    return this.fixed(this.u32(`${what} length`), what);
  }

  /** UTF-8, and invalid UTF-8 is an error rather than a replacement character. */
  text(what = 'text'): string {
    const bytes = this.lenbytes(what);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ProtocolError(`invalid UTF-8 in ${what}`);
    }
  }

  varbytes(what = 'varbytes'): Uint8Array {
    const out: number[] = [];
    for (;;) {
      if (this.exhausted) {
        throw new ProtocolError(`unterminated ${what}`);
      }
      const b = this.#bytes[this.#at++]!;
      if (b !== 0x00) {
        out.push(b);
        continue;
      }
      if (this.exhausted) {
        throw new ProtocolError(`unterminated ${what}`);
      }
      const esc = this.#bytes[this.#at++]!;
      if (esc === 0x01) return Uint8Array.from(out);
      if (esc === 0xff) {
        out.push(0x00);
        continue;
      }
      throw new ProtocolError(
        `invalid escape 0x${esc.toString(16).padStart(2, '0')} in ${what}`,
      );
    }
  }
}
