/**
 * Everything this package offers that runs anywhere — Node.js or a browser.
 *
 * The two entries differ in one export: `connect`, because only Node.js can
 * open a TCP socket. Keeping the rest in one list is what stops the two entries
 * from drifting apart.
 */
export { Connection } from './connection.ts';
export type { Carrier } from './wire/carrier.ts';
export { wireUrl } from './wire/websocket.ts';
export { Cache, CacheArgumentError, CacheStatements, Lease } from './cache.ts';
export type { Ttl } from './cache.ts';
export { Consumer, ConsumerNameError } from './consumer.ts';
export {
  Vault,
  changePassphrase,
  seal,
  unseal,
  vaultAudit,
  vaultStatus,
} from './vault.ts';
export type { Page } from './vault.ts';
export { VaultArgumentError, VaultStatements } from './vault/statements.ts';
export type { Custody, SealState, VaultStatus } from './vault/frame.ts';
export type { ConsumerOptions, Message, Settle } from './consumer.ts';
export type { ConnectOptions, Reply } from './connection.ts';
export { encodeValue, writeValue } from './codec/encode.ts';
export { decodeValue, readValue } from './codec/decode.ts';
export { ByteReader, ByteWriter } from './codec/bytes.ts';
export {
  HandshakeError,
  NodeTooOldError,
  NotFollowableError,
  ProtocolError,
  RedirectLoopError,
  RefusalError,
  StaleRedirectError,
  TlsError,
  WrongNodeError,
} from './error.ts';
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
export { parseJson, JsonError } from './http/json.ts';
export type { JsonValue } from './http/json.ts';
export { interpret, InterpretError } from './http/interpret.ts';
export type { Names, Shape } from './http/interpret.ts';
export { readGeometry, GeoJsonError } from './http/geojson.ts';
export { readAnswerBody, readOutcome } from './http/answer.ts';
export type { HttpOutcome, Plan, Row } from './http/answer.ts';
export { HttpClient, HttpError, ElsewhereError } from './http/client.ts';
export { NotAnEventError } from './http/events.ts';
export type { FileEntry, Health, HttpOptions } from './http/client.ts';
