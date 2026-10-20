// ============================================================
// Command-Receipt Core (BASIS-STANDARDS, Master §5.17/§5.19/§10.6)
// ============================================================
// Wiederholungssicherheit für kritische Mutationen.
//
// Geroutete Socket-Aktionen nutzen runReceipted. Receipt und Engine haben
// eigene Transaktionen; jede Engine-Schreibtransaktion prüft den persistenten
// Ausführungsbesitzer und die erwartete Room-Revision. Takeover und erster
// Effekt konkurrieren auf derselben Receipt-Zeile. Nach einem committeten
// Effekt ist nur Replay/Resync erlaubt. Alte Besitzer dürfen auch Quittungen
// nicht überschreiben. Legacy-Clients ohne Token bleiben kompatibel.
//
// Ein neues Absichtstoken (commandId) für dieselbe Payload ist eine
// NEUE, zulässige Absicht — Receipts ersetzen keinen Fach-Check.
// Retention: Receipts aktiver Sitzungen werden nicht gelöscht (kein
// stilles Cleanup; GC ist ein benannter Folgeauftrag).
// ============================================================

import { createHash, randomUUID } from 'node:crypto';
import { withCommandExecution, type CommandExecution } from './commandExecution.js';
import { Prisma } from '@prisma/client';
import type { PrismaClient, CommandReceipt } from '@prisma/client';
import { logger } from '../../observability/logger.js';

export const CRITICAL_COMMAND_ACTIONS = [
  'ANSWER_SUBMIT',
  'JOKER_USE',
  'REVEAL',
  'ROUND_ADVANCE',
  'GAME_START',
  'GAME_PAUSE',
  'GAME_RESUME',
  'GAME_ABORT',
  'FIELD_OPEN',
  'BUZZ',
  'STEAL_BUZZ',
  'JUDGE',
  'BOARD_SWITCH',
  'BUZZER_OPEN',
  'HINT',
  'STEAL_JUDGE',
  'JOKER_5050',
  'JOKER_SPY',
  'JOKER_RISK',
] as const;
export type CriticalCommandAction = (typeof CRITICAL_COMMAND_ACTIONS)[number];

export interface ClaimActor {
  actorId: string;
  actorRole: string;
}

export type ClaimOutcome =
  | { kind: 'claimed' }
  | { kind: 'replay'; response: { success: boolean; error?: string; [k: string]: unknown } }
  | { kind: 'conflict'; reason: 'ACTOR_MISMATCH' | 'PAYLOAD_MISMATCH' }
  | { kind: 'in_progress' };

/** Transport-Metadaten, die zur fachlichen Absicht gehören NICHT. */
export function canonicalCommandPayload(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const { rejoinToken: _rt, ...rest } = payload as Record<string, unknown>;
    void _rt; // Transport-Metadaten (kein Teil der fachlichen Absicht)
    return rest;
  }
  return payload;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function hashCommandPayload(action: CriticalCommandAction, payload: unknown): string {
  const canonical = canonicalize(canonicalCommandPayload(payload));
  return createHash('sha256')
    .update(`${action}\u0000${JSON.stringify(canonical)}`)
    .digest('hex');
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

/**
 * Stellt den Claim für (roomId, commandId) im Rahmen der aufrufenden
 * Transaktion. Muss VOR der fachlichen Mutation laufen (gleiche Transaktion).
 */
export async function claimCommand(
  tx: Prisma.TransactionClient,
  args: {
    roomId: string;
    commandId: string;
    actor: ClaimActor;
    action: CriticalCommandAction;
    payload: unknown;
    stateVersion?: number;
  },
): Promise<ClaimOutcome> {
  const payloadHash = hashCommandPayload(args.action, args.payload);
  try {
    await tx.commandReceipt.create({
      data: {
        roomId: args.roomId,
        commandId: args.commandId,
        actorId: args.actor.actorId,
        actorRole: args.actor.actorRole,
        action: args.action,
        payloadHash,
        stateVersion: args.stateVersion ?? null,
        status: 'PENDING',
      },
    });
    return { kind: 'claimed' };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await tx.commandReceipt.findUnique({
      where: { roomId_commandId: { roomId: args.roomId, commandId: args.commandId } },
    });
    if (!existing) return { kind: 'in_progress' };
    if (existing.actorId !== args.actor.actorId || existing.payloadHash !== payloadHash) {
      // Never overwrite another actor/payload's saved result.
      return { kind: 'conflict', reason: existing.actorId !== args.actor.actorId ? 'ACTOR_MISMATCH' : 'PAYLOAD_MISMATCH' };
    }
    // Gleiche Absicht:
    if (existing.status === 'COMPLETED') {
      return { kind: 'replay', response: JSON.parse(existing.responseJson ?? '{"success":true}') };
    }
    if (existing.status === 'REJECTED') {
      return { kind: 'replay', response: JSON.parse(existing.responseJson ?? '{"success":false,"error":"COMMAND_CONFLICT"}') };
    }
    if (existing.status === 'FAILED') {
      // Kein Erfolgseintrag vorhanden → Retry erlaubt: Zeile zurücksetzen.
      await tx.commandReceipt.update({
        where: { roomId_commandId: { roomId: args.roomId, commandId: args.commandId } },
        data: { status: 'PENDING', responseJson: null },
      });
      return { kind: 'claimed' };
    }
    // PENDING: erster Request bearbeitet noch (gleiche Transaktionswelt).
    return { kind: 'in_progress' };
  }
}

/**
 * Abschluss: Mutation ist erfolgreich committet. Muss in derselben
 * Transaktion NACH der fachlichen Mutation laufen.
 */
export async function completeCommand(
  tx: Prisma.TransactionClient,
  args: { roomId: string; commandId: string; response: unknown },
): Promise<void> {
  await tx.commandReceipt.update({
    where: { roomId_commandId: { roomId: args.roomId, commandId: args.commandId } },
    data: { status: 'COMPLETED', responseJson: JSON.stringify(args.response) },
  });
}

/**
 * Abschluss: fachliche Ablehnung OHNE Status-Mutation (z.B. Phase-Fehler).
 * In derselben Transaktion (No-op) ausführen.
 */
export async function rejectCommand(
  tx: Prisma.TransactionClient,
  args: { roomId: string; commandId: string; response: { success: boolean; error: string } },
): Promise<void> {
  await tx.commandReceipt.update({
    where: { roomId_commandId: { roomId: args.roomId, commandId: args.commandId } },
    data: { status: 'REJECTED', responseJson: JSON.stringify(args.response) },
  });
}

/**
 * Abschluss: Mutation/Rollback fehlgeschlagen → KEIN Erfolgseintrag.
 * Nur aus dem Error-Pfad derselben Transaktion aufrufbar; wenn die
 * Transaktion selbst rollt, verschwindet auch diese Zeile wieder und
 * der Client kann sicher retryen.
 */
export async function failCommand(
  tx: Prisma.TransactionClient,
  args: { roomId: string; commandId: string },
): Promise<void> {
  try {
    await tx.commandReceipt.update({
      where: { roomId_commandId: { roomId: args.roomId, commandId: args.commandId } },
      data: { status: 'FAILED', responseJson: null },
    });
  } catch {
    logger.warn('failCommand: Receipt-Zeile nicht auffindbar (Rollback im Fluss)', {
      roomId: args.roomId, commandId: args.commandId,
    });
  }
}

// ============================================================
// Event-Ebenen-Wrapper (Integration ohne Engine-Umschreibung)
// ============================================================
// Die Engine behält ihre eigene CAS-Transaktion. Der Wrapper ergänzt eine
// persistierte Absichtsidentität und Recovery-Beobachtungen. Ein verlorenes
// COMPLETED-Write NACH einer Spielmutation wird durch die Revisionsbeobachtung
// erkannt (Room ODER GameState); der Retry erhält Resync statt Neu-Ausführung.
// ============================================================

const PENDING_WAIT_MS = 40;
const PENDING_MAX_MS = 4000;
const PENDING_LEASE_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ReceiptContext {
  roomId: string;
  commandId: string;
  actor: ClaimActor;
  action: CriticalCommandAction;
  payload: unknown;
  stateVersion?: number;
}

export type ReceiptedResult<T> =
  | { success: true; replayed: boolean; data: T }
  | { success: false; replayed: boolean; error: string; response?: { success: boolean; [key: string]: unknown } }
  | { success: false; replayed: false; resyncRequired: true; error: 'COMMAND_STATE_ADVANCED' };

function isBusinessDuplicateError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return [
    'ALREADY_ANSWERED', 'ALREADY_CLAIMED', 'STATE_CONFLICT', 'TIME_EXPIRED',
    'INVALID_PHASE', 'BUZZ_CLOSED', 'PLAYER_EXCLUDED', 'ALREADY_PROCESSED',
    'REVISION_CONFLICT',
  ].includes(msg);
}

async function readStateRevisions(prismaClient: PrismaClient, roomId: string) {
  const [room, state] = await Promise.all([
    prismaClient.room.findUnique({ where: { id: roomId }, select: { revision: true } }),
    prismaClient.roomGameState.findUnique({ where: { roomId }, select: { revision: true } }),
  ]);
  return { roomRevision: room?.revision ?? null, stateRevision: state?.revision ?? null };
}

/** Takeover competes with the first engine write on the SAME receipt row. */
export async function claimTakeover(
  prismaClient: PrismaClient,
  args: {
    roomId: string;
    commandId: string;
    expectedStatus: 'FAILED' | 'PENDING';
    expectedLease: Date | null;
    executionToken?: string;
  },
): Promise<boolean> {
  const taken = await prismaClient.commandReceipt.updateMany({
    where: {
      roomId: args.roomId, commandId: args.commandId,
      status: args.expectedStatus, leaseExpiresAt: args.expectedLease,
      mutationStartedAt: null,
    },
    data: {
      status: 'PENDING', responseJson: null,
      executionToken: args.executionToken ?? randomUUID(),
      leaseExpiresAt: new Date(Date.now() + PENDING_LEASE_MS),
    },
  });
  return taken.count === 1;
}

/**
 * Receipt claim and response storage surround the engine's own transactions.
 * assertCommandMutation (shared state CAS + lifecycle start) fences every
 * routed engine write INSIDE that transaction. Thus an expired owner cannot
 * mutate after takeover, and the client revision is checked at the write.
 * Once a mutation marker is committed, recovery only replays/resyncs.
 */
export async function runReceipted<T>(
  prismaClient: PrismaClient,
  args: ReceiptContext & {
    mutate: () => Promise<T>;
    toResponse: (data: T) => { success: boolean; [k: string]: unknown };
  },
): Promise<ReceiptedResult<T>> {
  const { roomId, commandId } = args;
  const payloadHash = hashCommandPayload(args.action, args.payload);
  const executionToken = randomUUID();
  let recoverySnapshot: CommandExecution['recoverySnapshot'];
  const key = { roomId_commandId: { roomId, commandId } };
  const ownedKey = { ...key, executionToken, status: 'PENDING' };
  const now = await readStateRevisions(prismaClient, roomId);
  if (now.roomRevision === null) return { success: false, replayed: false, error: 'ROOM_NOT_FOUND' };

  const receiptOutcome = (row: CommandReceipt | null): ReceiptedResult<T> | null => {
    if (!row) return null;
    if (row.actorId !== args.actor.actorId || row.payloadHash !== payloadHash || row.action !== args.action) {
      return { success: false, replayed: false, error: 'COMMAND_CONFLICT' };
    }
    if (row.status === 'COMPLETED') {
      return { success: true, replayed: true, data: JSON.parse(row.responseJson ?? '{}') as T };
    }
    if (row.status === 'REJECTED') {
      const response = JSON.parse(row.responseJson ?? '{}') as { success: boolean; error?: string };
      return { success: false, replayed: true, error: response.error ?? 'REJECTED', response };
    }
    return null;
  };
  const readOutcome = async () => receiptOutcome(await prismaClient.commandReceipt.findUnique({ where: key }));
  const lostOwnership = async (): Promise<ReceiptedResult<T>> =>
    (await readOutcome()) ?? { success: false, replayed: false, error: 'COMMAND_IN_PROGRESS' };

  try {
    await prismaClient.commandReceipt.create({ data: {
      roomId, commandId, actorId: args.actor.actorId, actorRole: args.actor.actorRole,
      action: args.action, payloadHash, stateVersion: args.stateVersion ?? null,
      beforeRevision: now.roomRevision, beforeStateRevision: now.stateRevision,
      executionToken, leaseExpiresAt: new Date(Date.now() + PENDING_LEASE_MS), status: 'PENDING',
    } });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const deadline = Date.now() + PENDING_MAX_MS;
    for (;;) {
      const existing = await prismaClient.commandReceipt.findUnique({ where: key });
      const outcome = receiptOutcome(existing);
      if (outcome) return outcome; // Replay before any revision/business check.
      if (!existing) return { success: false, replayed: false, error: 'COMMAND_IN_PROGRESS' };
      if (existing.status !== 'FAILED' && existing.status !== 'PENDING') {
        return { success: false, replayed: false, resyncRequired: true, error: 'COMMAND_STATE_ADVANCED' };
      }
      const live = existing.status === 'PENDING' && existing.leaseExpiresAt && existing.leaseExpiresAt.getTime() > Date.now();
      if (!live) {
        if (await retrySafetyVerdict(prismaClient, roomId, existing) !== 'safe') {
          return { success: false, replayed: false, resyncRequired: true, error: 'COMMAND_STATE_ADVANCED' };
        }
        if (await claimTakeover(prismaClient, {
          roomId, commandId, expectedStatus: existing.status as 'FAILED' | 'PENDING',
          expectedLease: existing.leaseExpiresAt, executionToken,
        })) {
          recoverySnapshot = { roomRevision: existing.beforeRevision!, stateRevision: existing.beforeStateRevision };
          break;
        }
      }
      if (Date.now() >= deadline) return { success: false, replayed: false, error: 'COMMAND_IN_PROGRESS' };
      await sleep(PENDING_WAIT_MS);
    }
  }

  const execution: CommandExecution = { roomId, commandId, executionToken, expectedRevision: args.stateVersion, recoverySnapshot, closed: false };
  try {
    // Fast rejection after claim. The authoritative check is ALSO in the
    // engine transaction; a read here alone cannot protect a delayed handler.
    const fresh = await prismaClient.room.findUnique({ where: { id: roomId }, select: { revision: true } });
    if (args.stateVersion !== undefined && fresh?.revision !== args.stateVersion) {
      await prismaClient.commandReceipt.update({ where: ownedKey, data: {
        status: 'REJECTED', responseJson: JSON.stringify({ success: false, error: 'REVISION_CONFLICT' }), leaseExpiresAt: null,
      } });
      return { success: false, replayed: false, error: 'REVISION_CONFLICT' };
    }
    const data = await withCommandExecution(execution, args.mutate);
    const response = args.toResponse(data);
    if (response.error === 'COMMAND_STATE_ADVANCED') response.resyncRequired = true;
    await prismaClient.commandReceipt.update({ where: ownedKey, data: {
      status: response.success ? 'COMPLETED' : 'REJECTED',
      responseJson: JSON.stringify(response), leaseExpiresAt: null,
    } });
    if (response.resyncRequired) return { success: false, replayed: false, resyncRequired: true, error: 'COMMAND_STATE_ADVANCED' };
    return response.success
      ? { success: true, replayed: false, data }
      : { success: false, replayed: false, error: String(response.error ?? 'REJECTED'), response };
  } catch (error) {
    // Old owners must not overwrite a takeover winner's result (including
    // its COMPLETED row) when their engine eventually returns or throws.
    const row = await prismaClient.commandReceipt.findUnique({ where: key });
    if (row?.executionToken !== executionToken || row.status !== 'PENDING') return lostOwnership();
    if (isBusinessDuplicateError(error)) {
      const msg = error instanceof Error ? error.message : 'STATE_CONFLICT';
      await prismaClient.commandReceipt.update({ where: ownedKey, data: {
        status: 'REJECTED', responseJson: JSON.stringify({ success: false, error: msg }), leaseExpiresAt: null,
      } }).catch(() => undefined);
      return { success: false, replayed: false, error: msg };
    }
    await prismaClient.commandReceipt.update({ where: ownedKey, data: {
      status: 'FAILED', responseJson: null, leaseExpiresAt: null,
    } }).catch(() => undefined);
    throw error;
  } finally {
    execution.closed = true;
  }
}

async function retrySafetyVerdict(
  prismaClient: PrismaClient,
  roomId: string,
  existing: { beforeRevision: number | null; beforeStateRevision?: number | null; mutationStartedAt?: Date | null },
): Promise<'legacy' | 'advanced' | 'safe'> {
  if (existing.mutationStartedAt) return 'advanced';
  if (existing.beforeRevision === null || existing.beforeStateRevision === undefined) return 'legacy';
  const now = await readStateRevisions(prismaClient, roomId);
  if (now.roomRevision === null || now.roomRevision !== existing.beforeRevision) return 'advanced';
  return now.stateRevision === existing.beforeStateRevision ? 'safe' : 'advanced';
}
