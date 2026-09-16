import { ByteReader } from '../codec/bytes.ts';
import { readValue } from '../codec/decode.ts';
import { ProtocolError } from '../error.ts';
import type { Value } from '../value.ts';

/** How the store found the records. An unrecognised path reads as `scan` — the one path that promises nothing. */
export type AccessPath =
  | 'record'
  | 'index'
  | 'scan'
  | 'ordered'
  | 'approximate'
  | 'graph'
  | 'join'
  | 'materialised'
  | 'span';

const PATHS: AccessPath[] = [
  'record',
  'index',
  'scan',
  'ordered',
  'approximate',
  'graph',
  'join',
  'materialised',
  'span',
];

/** A note is a kind and a message. The kinds are an **open** set — an unfamiliar one is never an error. */
export interface Note {
  kind: string;
  message: string;
}

/**
 * Three states, and a client whose type for this is a boolean has already lost
 * the distinction.
 *
 * `unstated` is not `exact`. A node that predates the field did not serve exact
 * answers and forget to say so — it made no claim at all, and reading absence as
 * a promise puts words in its mouth on the one property whose whole purpose is
 * that a caller never has to infer it.
 */
export type Exactness =
  { kind: 'exact' } | { kind: 'inexact'; reason: string } | { kind: 'unstated' };

/**
 * Also three states, and `not-consulted` is not `complete`.
 *
 * `complete` is a claim about the collection: a term dictionary was asked and
 * found nothing to fix. `not-consulted` is the absence of a claim — nothing was
 * looked for. Rendering both as "no suggestions" reports a negative the node never
 * checked, on every read of an unindexed field.
 */
export type Suggestion =
  | { kind: 'not-consulted' }
  | { kind: 'complete' }
  | { kind: 'corrections'; items: { typed: string; instead: string }[] };

export interface RecordRow {
  identity: string;
  value: Value;
}

export type Outcome =
  | { kind: 'done' }
  | {
      kind: 'records';
      path: AccessPath;
      names: Map<number, string>;
      records: RecordRow[];
      notes: Note[];
      only: boolean;
      exactness: Exactness;
      suggestion: Suggestion;
    }
  | { kind: 'value'; names: Map<number, string>; value: Value }
  | { kind: 'keys'; keys: string[] }
  | { kind: 'removed'; count: bigint }
  /** A tag this build does not know. Surfaced, never dropped — saying so is honest where guessing is not. */
  | { kind: 'unknown'; tag: number; bytes: Uint8Array };

const OUTCOME = {
  done: 0,
  records: 1,
  value: 2,
  keys: 3,
  removed: 4,
  unknown: 255,
} as const;

/**
 * Decode an Answer body.
 *
 * Every outcome carries its own length, and that length is what makes an unknown
 * one survivable: read it, yield `unknown`, step over the rest, carry on. It is
 * also a **bound** — a recognised tag whose body claims more than its length
 * allows is malformed, and treating the length as advisory turns one corrupt
 * outcome into a mis-parse of every outcome after it.
 */
export function readAnswer(body: Uint8Array): Outcome[] {
  const r = new ByteReader(body);
  const count = r.u32('outcome count');
  const outcomes: Outcome[] = [];
  for (let i = 0; i < count; i++) {
    const length = r.u32('outcome length');
    if (length < 1) throw new ProtocolError('an outcome carries at least its tag');
    const slice = r.fixed(length, 'outcome body');
    outcomes.push(readOutcome(slice));
  }
  return outcomes;
}

function readOutcome(slice: Uint8Array): Outcome {
  const r = new ByteReader(slice);
  const tag = r.u8('outcome tag');
  switch (tag) {
    case OUTCOME.done:
      return { kind: 'done' };
    case OUTCOME.records:
      return readRecords(r);
    case OUTCOME.value: {
      const names = readNames(r);
      return { kind: 'value', names, value: readValue(r) };
    }
    case OUTCOME.keys: {
      const count = r.u32('key count');
      const keys: string[] = [];
      for (let i = 0; i < count; i++) keys.push(r.text('key'));
      return { kind: 'keys', keys };
    }
    case OUTCOME.removed:
      return { kind: 'removed', count: r.u64('removed count') };
    default:
      // Tag 255 is the client's own report and is never sent by a node; every
      // other unrecognised tag lands here too. The bytes are kept so a caller can
      // say what it could not read.
      return { kind: 'unknown', tag, bytes: slice.slice(1) };
  }
}

/**
 * Fields were appended to this outcome over time, and the rule for all but one of
 * them is that **absent means the default** — because the default is what an
 * older node's read actually was. Exactness is the deliberate exception.
 */
function readRecords(r: ByteReader): Outcome {
  const path = PATHS[r.u8('access path')] ?? 'scan';
  const names = readNames(r);

  const recordCount = r.u32('record count');
  const records: RecordRow[] = [];
  for (let i = 0; i < recordCount; i++) {
    const identity = r.text('record identity');
    const bytes = r.lenbytes('record value');
    records.push({ identity, value: decodeComplete(bytes) });
  }

  // From here every field may simply be absent: a node built before it existed
  // ends the body, and that is a node with nothing to say, not a truncation.
  const notes: Note[] = [];
  if (r.exhausted)
    return done(path, names, records, notes, false, unstated(), silence());
  const noteCount = r.u32('note count');
  for (let i = 0; i < noteCount; i++) {
    const kind = r.text('note kind');
    notes.push({ kind, message: r.text('note message') });
  }

  if (r.exhausted)
    return done(path, names, records, notes, false, unstated(), silence());
  const only = r.u8('only flag') !== 0;

  if (r.exhausted)
    return done(path, names, records, notes, only, unstated(), silence());
  const exactByte = r.u8('exactness');
  const reason = r.text('exactness reason');
  const exactness: Exactness =
    exactByte === 0 ? { kind: 'exact' } : { kind: 'inexact', reason };

  if (r.exhausted) return done(path, names, records, notes, only, exactness, silence());
  const suggestion = readSuggestion(r);
  return done(path, names, records, notes, only, exactness, suggestion);
}

function readSuggestion(r: ByteReader): Suggestion {
  const state = r.u8('suggestion state');
  if (state === 1) return { kind: 'complete' };
  if (state === 2) {
    const count = r.u32('suggestion count');
    const items: { typed: string; instead: string }[] = [];
    for (let i = 0; i < count; i++) {
      const typed = r.text('suggestion typed');
      items.push({ typed, instead: r.text('suggestion instead') });
    }
    return { kind: 'corrections', items };
  }
  // State 0, and any state this build does not know, read as silence.
  return silence();
}

const unstated = (): Exactness => ({ kind: 'unstated' });
const silence = (): Suggestion => ({ kind: 'not-consulted' });

function done(
  path: AccessPath,
  names: Map<number, string>,
  records: RecordRow[],
  notes: Note[],
  only: boolean,
  exactness: Exactness,
  suggestion: Suggestion,
): Outcome {
  return { kind: 'records', path, names, records, notes, only, exactness, suggestion };
}

/**
 * The names block. A table reference carries an id and the name lives in the
 * catalog on the server; without this a client can only render an opaque
 * reference, and the point of the protocol is that a client decides nothing.
 */
function readNames(r: ByteReader): Map<number, string> {
  const count = r.u32('name count');
  const names = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const id = r.u32('table id');
    names.set(id, r.text('table name'));
  }
  return names;
}

function decodeComplete(bytes: Uint8Array): Value {
  const r = new ByteReader(bytes);
  const value = readValue(r);
  if (!r.exhausted) {
    throw new ProtocolError(`${r.remaining} trailing byte(s) after a record's value`);
  }
  return value;
}
