import { ByteWriter } from '../codec/bytes.ts';
import { ProtocolError } from '../error.ts';
import type { Value } from '../value.ts';
import type { Credentials } from '../wire/message.ts';

/**
 * The vault frame's body (protocol §3.14) and the status every act answers
 * with. The passphrase is a field of the frame and never statement text, and no
 * type here holds one.
 */
export type VaultAct =
  | { act: 'status' }
  | { act: 'unseal'; passphrase: string }
  | { act: 'seal' }
  | { act: 'change'; current: string; next: string };

/** The tenancy and name of one vault, as the frame names it. */
export type Place = readonly [namespace: string, database: string, vault: string];

const ACT = { status: 1, unseal: 2, seal: 3, change: 4 } as const;

/** Credentials, the target (the store, or one vault), then the act and its fields. */
export function frameBody(
  credentials: Credentials | undefined,
  act: {
    act: VaultAct['act'];
    passphrase?: string | undefined;
    current?: string | undefined;
    next?: string | undefined;
  },
  place?: Place,
): Uint8Array {
  const w = new ByteWriter();
  if (credentials) {
    w.u8(1);
    w.text(credentials.user);
    w.text(credentials.password);
  } else {
    w.u8(0);
  }
  if (place) {
    w.u8(1);
    for (const name of place) w.text(name);
  } else {
    w.u8(0);
  }
  w.u8(ACT[act.act]);
  if (act.act === 'unseal') w.text(act.passphrase ?? '');
  if (act.act === 'change') {
    w.text(act.current ?? '');
    w.text(act.next ?? '');
  }
  return w.finish();
}

/** Whether the node can open secrets. */
export type SealState = 'uninitialised' | 'sealed' | 'unsealed';

/** What opens a vault: its own passphrase, or the store's (whose state is then reported). */
export type Custody = 'own' | 'store';

/** The node's answer to every vault act. */
export interface VaultStatus {
  state: SealState;
  /** When the key held now stops opening anything; absent unless unsealed. */
  sealsAt?: Date;
  /** How long an unseal lasts on this node, in milliseconds. */
  unsealForMs: number;
  /** Whether this unseal set the store's first passphrase. */
  initialised: boolean;
  /** For an act on one vault, what opens it; absent for the store's own. */
  custody?: Custody;
}

const STATES: readonly SealState[] = ['uninitialised', 'sealed', 'unsealed'];
const CUSTODIES: readonly Custody[] = ['own', 'store'];

function isState(held: string): held is SealState {
  return (STATES as readonly string[]).includes(held);
}

function isCustody(held: string): held is Custody {
  return (CUSTODIES as readonly string[]).includes(held);
}

/** Read the status object; anything outside its closed sets is refused. */
export function readStatus(value: Value): VaultStatus {
  if (value.kind !== 'object') throw new ProtocolError('a vault status is an object');
  const state = value.fields.get('state');
  const period = value.fields.get('unseal_for');
  if (
    state?.kind !== 'string' ||
    !isState(state.value) ||
    period?.kind !== 'duration'
  ) {
    throw new ProtocolError('a vault status carries a known state and a period');
  }
  const initialised = value.fields.get('initialised');
  const status: VaultStatus = {
    state: state.value,
    unsealForMs: Number(period.seconds) * 1000 + Math.floor(period.nanos / 1_000_000),
    initialised: initialised?.kind === 'bool' && initialised.value,
  };
  const sealsAt = value.fields.get('seals_at');
  if (sealsAt?.kind === 'datetime') {
    status.sealsAt = new Date(
      Number(sealsAt.seconds) * 1000 + Math.floor(sealsAt.nanos / 1_000_000),
    );
  } else if (sealsAt !== undefined && sealsAt.kind !== 'none') {
    throw new ProtocolError('seals_at is a datetime');
  }
  const custody = value.fields.get('custody');
  if (custody !== undefined) {
    if (custody.kind !== 'string' || !isCustody(custody.value)) {
      throw new ProtocolError('custody is own or store');
    }
    status.custody = custody.value;
  }
  return status;
}
