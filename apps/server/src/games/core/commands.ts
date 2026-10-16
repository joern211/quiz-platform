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
// Audit PR14, 14-02: PENDING-Lease. Ein normaler Command (Engine-Mutation
// + Persistenz) läuft deutlich unter dieser Grenze; ein abgestürzter
// Prozess hinterlässt PENDING und der Retry wartet höchstens die Lease
// statt COMMAND_IN_PROGRESS für immer.
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
  | { success: false; replayed: boolean; error: string }
  // Audit PR14, 14-02: Der ursprüngliche Command hat bereits eine Wirkung
  // committet (Room-Revision fortgeschritten), aber die Erfolgs-Quittung
  // ist verloren gegangen. Eine NEUE Ausführung ist verboten (Doppelwirkung
  // unmöglich); der Client resync-t, statt erneut zu mutieren.
  | { success: false; replayed: false; resyncRequired: true; error: 'COMMAND_STATE_ADVANCED' };

function isBusinessDuplicateError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return [
    'ALREADY_ANSWERED', 'ALREADY_CLAIMED', 'STATE_CONFLICT', 'TIME_EXPIRED',
    'INVALID_PHASE', 'BUZZ_CLOSED', 'PLAYER_EXCLUDED', 'ALREADY_PROCESSED',
  ].includes(msg);
}

// ============================================================
// Audit PR14, 14-02 (Nacharbeit): Versionserwartung + Replay-Semantik
// ============================================================
// Die mitgesendete stateVersion/expectedRevision hat genau EINE Bedeutung:
// "Ich warte auf diesen Zustand." Für eine NEUE Mutation muss sie zum
// aktuellen Zustand passen (sonst REVISION_CONFLICT — die Mutation würde
// auf veraltetem Zustand aufbauen). Für ein REPLAY eines bereits
// abgeschlossenen Commands ist sie dagegen KEIN Hindernis: die gespeicherte
// Antwort gilt für dieselbe Absicht, und die eigene Wirkung hat die Revision
// selbst erhöht — ein identischer Retry (verlorenes ACK) muss dieselbe
// Antwort liefern, nicht REVISION_CONFLICT (Audit-Beleg: REVIEW_REPLAY).
// Die Prüfung läuft daher NACH der Duplicate-/Replay-Auflösung und NUR auf
// dem Pfad, der tatsächlich eine neue Mutation ausführt.

/** Liest die aktuelle (Room-Revision, GameState-Revision) eines Raums. */
async function readStateRevisions(
  prismaClient: PrismaClient,
  roomId: string,
): Promise<{ roomRevision: number | null; stateRevision: number | null }> {
  const [roomNow, stateNow] = await Promise.all([
    prismaClient.room.findUnique({ where: { id: roomId }, select: { revision: true } }),
    prismaClient.roomGameState.findUnique({ where: { roomId }, select: { revision: true } }),
  ]);
  return { roomRevision: roomNow?.revision ?? null, stateRevision: stateNow?.revision ?? null };
}

/**
 * Audit PR14, 14-02: Exklusive Übernahme einer Receipt-Zeile (FAILED→PENDING
 * oder PENDING-Recovery). `updateMany` unterstützt den Composite-Key
 * (roomId, commandId) nicht als Filter — die einzelnen Skalaren roomId +
 * commandId sind jedoch ein vollständig atomares CAS: genau eine der
 * parallelen Retry-Zeilen erfüllt Status + Lease-Bedingung und gewinnt,
 * die anderen sehen count 0 und verlieren fair (keine Doppelwirkung).
 */
export async function claimTakeover(
  prismaClient: PrismaClient,
  args: {
    roomId: string;
    commandId: string;
    expectedStatus: 'FAILED' | 'PENDING';
    /** Exakte Lease zum Übernahme-Zeitpunkt (Date) oder null (Legacy-Zeile). */
    expectedLease: Date | null;
  },
): Promise<boolean> {
  const taken = await prismaClient.commandReceipt.updateMany({
    where: {
      roomId: args.roomId,
      commandId: args.commandId,
      status: args.expectedStatus,
      // Atomare CAS-Bedingung auf die EXAKTE Lease (DateTime-Filter auf
      // den gespeicherten Wert): ein bereits übernommener Gewinner hat eine
      // neuere Lease und lässt das Update nicht mehr zu.
      leaseExpiresAt: args.expectedLease,
    },
    data: {
      status: 'PENDING',
      responseJson: null,
      leaseExpiresAt: new Date(Date.now() + PENDING_LEASE_MS),
    },
  });
  return taken.count === 1;
}

/**
 * Führt eine kritische Mutation mit Receipt-Schutz aus (s. Block oben).
 *
 * Audit PR14, 14-02/14-03 (Nacharbeit) — Ausführungsfreiheit nur mit
 * Doppel-Beleg:
 *   0) Zuerst wird die EXISTENZ der Absicht aufgelöst (Replay): ein
 *      COMPLETED-Receipt liefert die gespeicherte Antwort (replayed), ein
 *      REJECTED-Receipt die gespeicherte Ablehnung — die Versionserwartung
 *      darf ein gültiges Replay nicht blockieren (Audit-Beleg:
 *      REVIEW_REPLAY_REVISION).
 *   1) Nur wer neu ausführt (kein Duplicate/Replay/In-Progress) wird
 *      versionstechnisch geprüft: mitgesendete stateVersion/expectedRevision
 *      muss zur aktuellen Room-Revision passen, sonst REVISION_CONFLICT —
 *      VOR jeder Mutation, auf Basis eines frischen Reads.
 *   2) Der Claim speichert beide Beobachtungen (beforeRevision = Room,
 *      beforeStateRevision = GameState) + PENDING-Lease.
 *   3) Retry auf FAILED / abgelaufenes PENDING ist NUR erlaubt, wenn WEDER
 *      die Room- noch die GameState-Revision fortgeschritten sind. War
 *      IRGENDWELCHER Zustand fortgeschritten, hat der ursprüngliche Command
 *      gewirkt (verlorenes Erfolgs-Receipt) → COMMAND_STATE_ADVANCED
 *      (resyncRequired), NICHT eine zweite Ausführung (Audit-Beleg:
 *      REVIEW_DOUBLE_JUDGE).
 *   4) Die FAILED→PENDING-Übernahme ist ein exklusiver CAS (Status + alte
 *      Lease als Bedingung): parallele Retry-Claims konkurrieren fair.
 *   5) Die Engine-Mutation behält ihre eigene CAS-Transaktion
 *      (saveGameStateIfRevision & Co.) — Projektionen/Emits erst danach.
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

  // 0) Duplikat-Auflösung (Replay VOR Versionsprüfung, Audit 14-03b):
  //    COMPLETED/REJECTED → gespeicherte Antwort; FAILED / abgelaufenes
  //    PENDING → sichere Retry-Entscheidung über den DOPPELTEN Zustand
  //    (Room + GameState, Audit 14-02); lebendes PENDING → kurz warten.
  let claimed = false;
  try {
    await prismaClient.commandReceipt.create({
      data: {
        roomId, commandId,
        actorId: args.actor.actorId, actorRole: args.actor.actorRole,
        action: args.action, payloadHash,
        status: 'PENDING',
        // before*/leaseExpiresAt werden im 2) direkt nach dem Claim gesetzt
        // (Legacy-Zeilen ohne Snapshot = NULL → konservative Resync-Regel).
      },
    });
    claimed = true;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Duplicate-Pfad: auf den Gewinner warten bzw. gespeicherte Antwort
    // liefern; abgelaufene PENDING-Lease / FAILED → Retry-Entscheidung.
    for (let waited = 0; ; waited += PENDING_WAIT_MS) {
      const existing = await prismaClient.commandReceipt.findUnique({
        where: { roomId_commandId: { roomId, commandId } },
      });
      if (!existing) { claimed = true; break; }
      if (existing.actorId !== args.actor.actorId || existing.payloadHash !== payloadHash) {
        return { success: false, replayed: false, error: 'COMMAND_CONFLICT' };
      }
      if (existing.status === 'COMPLETED') {
        // Audit 14-03b: gültiges Replay — Versionserwartung ist hier KEIN
        // Hindernis (die eigene Wirkung hat die Revision erhöht).
        return { success: true, replayed: true, data: JSON.parse(existing.responseJson ?? '{}') as T };
      }
      if (existing.status === 'REJECTED') {
        return { success: false, replayed: true, error: (JSON.parse(existing.responseJson ?? '{}') as { error?: string }).error ?? 'COMMAND_CONFLICT' };
      }
      if (existing.status === 'FAILED') {
        // Kein Erfolgseintrag — Retry nur bei voll unverändertem Zustand.
        const verdict = await retrySafetyVerdict(prismaClient, roomId, existing);
        if (verdict === 'advanced') {
          return { success: false, replayed: false, resyncRequired: true, error: 'COMMAND_STATE_ADVANCED' };
        }
        const claimedOver = await claimTakeover(prismaClient, {
          roomId, commandId, expectedStatus: 'FAILED', expectedLease: existing.leaseExpiresAt,
        });
        if (claimedOver) { claimed = true; break; }
        if (waited >= PENDING_MAX_MS) return { success: false, replayed: false, error: 'COMMAND_IN_PROGRESS' };
        await sleep(PENDING_WAIT_MS);
      }
      // PENDING: Gewinn in Bearbeitung ODER abgestürzt.
      const leaseLive = existing.leaseExpiresAt !== null && existing.leaseExpiresAt.getTime() > Date.now();
      if (leaseLive) {
        if (waited >= PENDING_MAX_MS) return { success: false, replayed: false, error: 'COMMAND_IN_PROGRESS' };
        await sleep(PENDING_WAIT_MS);
        continue;
      }
      // Lease abgelaufen (oder Legacy-Zeile ohne Lease) → der ursprüngliche
      // Besitzer gilt als abgestürzt (Recovery).
      const verdict = await retrySafetyVerdict(prismaClient, roomId, existing);
      if (verdict === 'advanced') {
        return { success: false, replayed: false, resyncRequired: true, error: 'COMMAND_STATE_ADVANCED' };
      }
      const recovered = await claimTakeover(prismaClient, {
        roomId, commandId, expectedStatus: 'PENDING', expectedLease: existing.leaseExpiresAt,
      });
      if (recovered) { claimed = true; break; }
      if (waited >= PENDING_MAX_MS) return { success: false, replayed: false, error: 'COMMAND_IN_PROGRESS' };
      await sleep(PENDING_WAIT_MS);
    }
  }

  // 1) Versionsprüfung für NEUE Mutationen (Audit 14-03): frischer Read,
  //    VOR der Mutation, NACH der Duplicate-Auflösung.
  const now = await readStateRevisions(prismaClient, roomId);
  if (now.roomRevision === null) {
    // Raum weg: Claim zurücknehmen (nein: Zeile behalten, Ablehnung).
    await prismaClient.commandReceipt.update({
      where: { roomId_commandId: { roomId, commandId } },
      data: { status: 'REJECTED', responseJson: JSON.stringify({ success: false, error: 'ROOM_NOT_FOUND' }), leaseExpiresAt: null },
    }).catch(() => undefined);
    return { success: false, replayed: false, error: 'ROOM_NOT_FOUND' };
  }
  if (args.stateVersion !== undefined && args.stateVersion !== null && now.roomRevision !== args.stateVersion) {
    await prismaClient.commandReceipt.update({
      where: { roomId_commandId: { roomId, commandId } },
      data: { status: 'REJECTED', responseJson: JSON.stringify({ success: false, error: 'REVISION_CONFLICT' }), leaseExpiresAt: null },
    }).catch(() => undefined);
    return { success: false, replayed: false, error: 'REVISION_CONFLICT' };
  }

  // 2) Beide Zustandsschnappschüsse + Lease atomar zum Claim festhalten.
  await prismaClient.commandReceipt.update({
    where: { roomId_commandId: { roomId, commandId } },
    data: {
      beforeRevision: now.roomRevision,
      beforeStateRevision: now.stateRevision,
      stateVersion: args.stateVersion ?? null,
      leaseExpiresAt: new Date(Date.now() + PENDING_LEASE_MS),
    },
  });

  // 3) Fachliche Mutation. 4) Erfolgs-/Ablehnungs-Quittung (Root-Write
  //    NACH dem Commit — sie kann verloren gehen; der doppelte
  //    Zustandsschnappschuss macht den Retry dann trotzdem sicher).
  try {
    const data = await args.mutate();
    const response = args.toResponse(data);
    if (response.success) {
      await prismaClient.commandReceipt.update({
        where: { roomId_commandId: { roomId, commandId } },
        data: { status: 'COMPLETED', responseJson: JSON.stringify(response), leaseExpiresAt: null },
      });
      return { success: true, replayed: false, data };
    }
    await prismaClient.commandReceipt.update({
      where: { roomId_commandId: { roomId, commandId } },
      data: { status: 'REJECTED', responseJson: JSON.stringify(response), leaseExpiresAt: null },
    });
    return { success: false, replayed: false, error: (response.error as string) ?? 'REJECTED' };
  } catch (error) {
    if (claimed) {
      if (isBusinessDuplicateError(error)) {
        // CAS-Schicht verhinderte eine zweite Wirkung → deterministische Ablehnung.
        const msg = error instanceof Error ? error.message : 'STATE_CONFLICT';
        await prismaClient.commandReceipt.update({
          where: { roomId_commandId: { roomId, commandId } },
          data: { status: 'REJECTED', responseJson: JSON.stringify({ success: false, error: msg }), leaseExpiresAt: null },
        }).catch(() => undefined);
        return { success: false, replayed: true, error: msg };
      }
      // Mutation fehlgeschlagen ODER COMPLETED-Write fehlgeschlagen
      // (Audit 14-02): FAILED + beider Schnappschüsse bleiben bestehen.
      // Der nachfolgende Retry entscheidet über Room UND GameState-Revision,
      // ob die Wirkung committet wurde → keine Doppelwirkung.
      await prismaClient.commandReceipt.update({
        where: { roomId_commandId: { roomId, commandId } },
        data: { status: 'FAILED', responseJson: null, leaseExpiresAt: null },
      }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Audit PR14, 14-02: Retry-Sicherheitsentscheidung für eine bestehende
 * FAILED-/abgelaufene-PENDING-Zeile.
 *   'legacy'    → kein Snapshot (vor der Nacharbeit) → Resync (konservativ)
 *   'advanced'  → Room- ODER GameState-Revision fortgeschritten → der
 *                 ursprüngliche Command hat gewirkt → Resync, keine Neu-
 *                 Ausführung (Audit-Beleg: REVIEW_DOUBLE_JUDGE).
 *   'safe'      → beide Revisions unverändert (bzw. GameState-Zeile
 *                 weiterhin nicht vorhanden) → sichere Neu-Ausführung.
 */
async function retrySafetyVerdict(
  prismaClient: PrismaClient,
  roomId: string,
  existing: { beforeRevision: number | null; beforeStateRevision?: number | null; leaseExpiresAt: Date | null },
): Promise<'legacy' | 'advanced' | 'safe'> {
  if (existing.beforeRevision === null) return 'legacy';
  const now = await readStateRevisions(prismaClient, roomId);
  if (now.roomRevision === null) return 'advanced';
  if (now.roomRevision !== existing.beforeRevision) return 'advanced';
  if (existing.beforeStateRevision === undefined) return 'legacy';
  if (existing.beforeStateRevision === null) {
    return now.stateRevision === null ? 'safe' : 'advanced';
  }
  if (now.stateRevision !== existing.beforeStateRevision) return 'advanced';
  return 'safe';
}
