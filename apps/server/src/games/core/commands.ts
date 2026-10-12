// ============================================================
// Command-Receipt Core (BASIS-STANDARDS, Master §5.17/§5.19/§10.6)
// ============================================================
// Wiederholungssicherheit für kritische Mutationen.
//
// Semantik (verbindlich):
//   - Ein Receipt pro (roomId, commandId). Der Claim läuft als
//     createUnique IMMER innerhalb derselben interaktiven Transaktion
//     wie die State-/Score-Mutation → kein Check-then-Create-Race:
//     parallele Duplikate erhalten P2002 und lesen den Gewinner.
//   - COMPLETED  → Duplicate liefert die GESPEICHERTE Antwort
//                  (replayed: true) — exakt dieselbe fachliche Wirkung.
//   - REJECTED   → Duplicate liefert die gespeicherte Ablehnung
//                  (z.B. COMMAND_CONFLICT).
//   - PENDING    → der erste Request ist noch in Bearbeitung (nur
//                  während derselben Transaktion sichtbar); parallele
//                  Duplikate warten kurz (SQLite serialisiert Writes)
//                  und liefern danach das finale Ergebnis.
//   - FAILED     → Mutation fehlgeschlagen/Rollback; es existiert KEIN
//                  Erfolgseintrag → ein sicherer Retry ist erlaubt
//                  (der Claim wird erneut gestellt).
//   - Gleiche commandId mit anderer Akteur-/Payload-Identität
//                  (anderer actorId ODER anderer payloadHash) →
//                  COMMAND_CONFLICT: keine fremden Ergebnisse, keine
//                  zusätzlichen Rechte.
//
// Ein neues Absichtstoken (commandId) für dieselbe Payload ist eine
// NEUE, zulässige Absicht — Receipts ersetzen keinen Fach-Check.
// Retention: Receipts aktiver Sitzungen werden nicht gelöscht (kein
// stilles Cleanup; GC ist ein benannter Folgeauftrag).
// ============================================================

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
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
      // Identität/Kontext weicht ab → kontrollierte Ablehnung. Das Resultat
      // wird als REJECTED-Zeile festgehalten, damit Duplikate dieselbe
      // Antwort sehen (deterministisch, keine neuen Rechte).
      const conflictResponse = { success: false, error: 'COMMAND_CONFLICT' };
      if (existing.status === 'PENDING') {
        // Gewinnt noch: nicht überschreiben; Ablehnung erst nach Commit.
        return { kind: 'conflict', reason: existing.actorId !== args.actor.actorId ? 'ACTOR_MISMATCH' : 'PAYLOAD_MISMATCH' };
      }
      await tx.commandReceipt.update({
        where: { roomId_commandId: { roomId: args.roomId, commandId: args.commandId } },
        data: { status: 'REJECTED', responseJson: JSON.stringify(conflictResponse) },
      });
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
// Wichtige Semantik (ehrlich dokumentiert):
//   Der Claim läuft als atomarer createUnique (unique auf (roomId,
//   commandId)) — kein Check-then-Create. Die fachliche Mutation nutzt
//   die CAS-geschützten Transaktionen der Engines (saveGameStateIfRevision
//   / updateMany mit Revision). Diese CAS-Schicht verhindert eine zweite
//   fachliche Wirkung, auch wenn ein PENDING-Receipt nach einem
//   Prozess-/ACK-Verlust erneut ausgeführt wird → "Receipt + CAS passen
//   zusammen". Duplicate liefert die GESPEICHTE Antwort (COMPLETED) bzw.
//   gespeicherte Ablehnung (REJECTED) mit replayed:true.
//   Ein Prozess-/ACK-Verlust NACH Commit lässt den Gewinner COMPLETED;
//   der Duplicate-Client holt sich die gespeicherte Antwort. Ein Verlust
//   VOR Commit lässt PENDING → Retry läuft die Mutation erneut; die
//   CAS-Schicht verhindert die zweite Wirkung (Business-Duplicate-Error
//   wird REJECTED gespeichert und deterministisch repliziert).
// ============================================================

const PENDING_WAIT_MS = 40;
const PENDING_MAX_MS = 4000;
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
  | { success: false; replayed: boolean; error: string };

function isBusinessDuplicateError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return [
    'ALREADY_ANSWERED', 'ALREADY_CLAIMED', 'STATE_CONFLICT', 'TIME_EXPIRED',
    'INVALID_PHASE', 'BUZZ_CLOSED', 'PLAYER_EXCLUDED', 'ALREADY_PROCESSED',
  ].includes(msg);
}

/**
 * Führt eine kritische Mutation mit Receipt-Schutz aus (s. Block oben).
 */
export async function runReceipted<T>(
  prismaClient: PrismaClient,
  args: ReceiptContext & {
    /** Die eigentliche fachliche Mutation (Engine-Handler, inkl. eigener CAS-Transaktion). */
    mutate: () => Promise<T>;
    /** Mapping Engine-Ergebnis → speicherbare Antwort (muss `success` tragen). */
    toResponse: (data: T) => { success: boolean; [k: string]: unknown };
  },
): Promise<ReceiptedResult<T>> {
  const { roomId, commandId } = args;
  const payloadHash = hashCommandPayload(args.action, args.payload);

  // 1) Atomarer Claim (createUnique — kein Check-then-Create).
  let claimed = false;
  try {
    await prismaClient.commandReceipt.create({
      data: {
        roomId, commandId,
        actorId: args.actor.actorId, actorRole: args.actor.actorRole,
        action: args.action, payloadHash,
        stateVersion: args.stateVersion ?? null,
        status: 'PENDING',
      },
    });
    claimed = true;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // 1b) Duplicate-Pfad: auf den Gewinner warten bzw. gespeicherte Antwort liefern.
    for (let waited = 0; ; waited += PENDING_WAIT_MS) {
      const existing = await prismaClient.commandReceipt.findUnique({
        where: { roomId_commandId: { roomId, commandId } },
      });
      if (!existing) { claimed = true; break; }
      if (existing.actorId !== args.actor.actorId || existing.payloadHash !== payloadHash) {
        return { success: false, replayed: false, error: 'COMMAND_CONFLICT' };
      }
      if (existing.status === 'COMPLETED') {
        return { success: true, replayed: true, data: JSON.parse(existing.responseJson ?? '{}') as T };
      }
      if (existing.status === 'REJECTED') {
        return { success: false, replayed: true, error: (JSON.parse(existing.responseJson ?? '{}') as { error?: string }).error ?? 'COMMAND_CONFLICT' };
      }
      if (existing.status === 'FAILED') {
        // Kein Erfolgseintrag → sicherer Retry: erneut als Claimant starten.
        await prismaClient.commandReceipt.update({
          where: { roomId_commandId: { roomId, commandId } },
          data: { status: 'PENDING', responseJson: null },
        });
        claimed = true;
        break;
      }
      // PENDING: Gewinner in Bearbeitung — kurz warten.
      if (waited >= PENDING_MAX_MS) {
        return { success: false, replayed: false, error: 'COMMAND_IN_PROGRESS' };
      }
      await sleep(PENDING_WAIT_MS);
    }
  }

  // 2) Fachliche Mutation + 3) Abschluss.
  try {
    const data = await args.mutate();
    const response = args.toResponse(data);
    if (response.success) {
      await prismaClient.commandReceipt.update({
        where: { roomId_commandId: { roomId, commandId } },
        data: { status: 'COMPLETED', responseJson: JSON.stringify(response) },
      });
      return { success: true, replayed: false, data };
    }
    await prismaClient.commandReceipt.update({
      where: { roomId_commandId: { roomId, commandId } },
      data: { status: 'REJECTED', responseJson: JSON.stringify(response) },
    });
    return { success: false, replayed: false, error: (response.error as string) ?? 'REJECTED' };
  } catch (error) {
    if (claimed) {
      if (isBusinessDuplicateError(error)) {
        // CAS-Schicht verhinderte eine zweite Wirkung → deterministische Ablehnung.
        const msg = error instanceof Error ? error.message : 'STATE_CONFLICT';
        await prismaClient.commandReceipt.update({
          where: { roomId_commandId: { roomId, commandId } },
          data: { status: 'REJECTED', responseJson: JSON.stringify({ success: false, error: msg }) },
        }).catch(() => undefined);
        return { success: false, replayed: true, error: msg };
      }
      await prismaClient.commandReceipt.update({
        where: { roomId_commandId: { roomId, commandId } },
        data: { status: 'FAILED', responseJson: null },
      }).catch(() => undefined);
    }
    throw error;
  }
}
