/**
 * A client for TessariDB, written from the protocol specification.
 *
 * This package links nothing from the database's own repository, in this language
 * or any other. What it depends on is the frame layout, the tag numbers, the
 * version byte and the value codec — all of which are specified, and the
 * specification is the interface.
 *
 * ## Two transports, and the choice is forced
 *
 * A node serves two surfaces and neither carries everything. Statements and
 * change subscriptions go over the **wire protocol**, because it carries the
 * store's full model of seventeen value types. Objects, files, backup and the
 * operational routes go over **HTTP**, because nothing else serves them.
 *
 * A caller never picks a transport per call. Routing statements over HTTP would
 * work, reach everything, and silently narrow every result — JSON carries six
 * types — and nothing at the call site would show what was lost.
 *
 * That is also why this package does not ship a browser build: a browser cannot
 * open a TCP socket, so a browser client could only be the HTTP half, which means
 * shipping the narrowing.
 *
 * ## There is no TLS on the wire protocol
 *
 * Credentials travel as given. Run this on a protected network, or behind
 * something that terminates TLS.
 */

export { connect, Connection } from './connection.ts';
export type { ConnectOptions, Reply } from './connection.ts';
export { encodeValue, writeValue } from './codec/encode.ts';
export { decodeValue, readValue } from './codec/decode.ts';
export { ByteReader, ByteWriter } from './codec/bytes.ts';
export { HandshakeError, ProtocolError, RefusalError } from './error.ts';
export { FrameStream, IoError, TruncatedError } from './wire/stream.ts';
export { CEILING, FRAME, TooLargeError, UnknownFrameError } from './wire/frame.ts';
export { readAnswer } from './wire/outcome.ts';
export type {
  AccessPath,
  Exactness,
  Note,
  Outcome,
  RecordRow,
  Suggestion,
} from './wire/outcome.ts';
export type {
  Change,
  Credentials,
  Elsewhere,
  Fate,
  Settlement,
} from './wire/message.ts';
export type {
  Bound,
  Geometry,
  Polygon,
  Position,
  RecordId,
  Ring,
  Value,
} from './value.ts';
export {
  CreateInTable,
  CreateRecord,
  DeleteRecord,
  Select,
  UpdateRecord,
  createInTable,
  createRecord,
  deleteRecord,
  select,
  updateRecord,
} from './query/statement.ts';
export type { Direction } from './query/statement.ts';
export { and, compare, or } from './query/filter.ts';
export type { Filter, Operator } from './query/filter.ts';
export { BuilderError } from './query/grammar.ts';
export type { NamePosition, RefusalReason, Rendered } from './query/grammar.ts';
