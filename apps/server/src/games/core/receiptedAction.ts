// ============================================================
// Receipted Socket-Handler Wrapper (BASIS-STANDARDS, §5.17/§10.6)
// ============================================================
// Verwendet die Command-Receipts in den UMGESTELLTEN kritischen
// Mutationen der Engines. Semantik:
//   - Protokollversion: explizit inkompatibel → CLIENT_VERSION_UNSUPPORTED
//     VOR der Mutation (Handshake + pro Command).
//   - Receipt-Modus NUR, wenn der Client ein Absichtstoken (commandId /
//     requestId) mitschickt. Gleiche Absicht → gespeicherte Antwort
//     (replayed:true), eine fachliche Wirkung. Neuer Token bei gleicher
//     Payload → neue, zulässige Absicht. Gleiche ID + andere
//     Payload/Akteur → COMMAND_CONFLICT.
//   - Ohne Absichtstoken: Legacy-Pfad (bestehendes Verhalten, ehrlich
//     dokumentiert — kein Fingerprint-Ersatz).
//   - Die `error`-Leads der Engines bleiben erhalten; `code/
//     messageKey/traceId` (AppError-Vertrag) werden ergänzend
//     mitsendet, wo die Engine einen Error zurückgibt (D).
// ============================================================

import type { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import type { GamePermission } from '@quiz/shared';
import { runReceipted } from './commands.js';
import { resolveCommandContextForSocket, type CommandContextResult } from './commandContext.js';
import { requireGamePermission } from './permissions.js';
import { wireErrorToAppError } from './appError.js';
import { gameErrorCode } from './errors.js';

export interface GuardedActionArgs {
  io: Server;
  socket: Socket;
  /** Engine-Aktionsschlüssel (z.B. 'buzz', 'judge'). */
  action: string;
  /** Für das Receipt: stable, actionsspezifische Keyliste (fachlich relevante Felder). */
  payload: unknown;
  /**
   * Das für die Aktion erforderliche Recht (§2.3). Default:
   * BUZZER_CONTROL (spielerische Basisaktion — PLAYER/HOST-Paket).
   */
  permission?: GamePermission;
  /**
   * Engine-Handler (macht seine eigene Rolle-/Phase-/CAS-Prüfung).
   * Rückgabewert = Fach-Ergebnis; ODER der Handler nutzt `onResult`
   * (callback-Style-Engines). `onResult` hat Vorrang, wenn gesetzt.
   */
  handler: (onResult: (r: EngineActionResult) => void) => Promise<EngineActionResult | void>;
}

export type EngineActionResult = { success: boolean; error?: string; [k: string]: unknown };

/**
 * Wartet auf das Engine-Ergebnis (callback-Style) — mit Timeout-Grenze,
 * damit ein nicht antwortender Handler den Socket nicht blockiert.
 */
export function awaitEngineResult(
  run: (onResult: (r: EngineActionResult) => void) => Promise<EngineActionResult | void>,
  timeoutMs = 15000,
): Promise<EngineActionResult> {
  return new Promise<EngineActionResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('ENGINE_RESULT_TIMEOUT'));
      }
    }, timeoutMs);
    run((r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    }).then((directResult) => {
      if (!settled && directResult && typeof directResult === 'object' && 'success' in directResult) {
        settled = true;
        clearTimeout(timer);
        resolve(directResult as EngineActionResult);
      }
    }).catch((error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

export async function runGuardedCriticalAction(
  args: GuardedActionArgs,
  callback?: (result: { success: boolean; error?: string; [k: string]: unknown }) => void,
): Promise<void> {
  const data = args.payload as { commandId?: unknown; requestId?: unknown; protocolVersion?: unknown };
  const cmdCtx: CommandContextResult = resolveCommandContextForSocket(data, args.socket);
  if (!cmdCtx.ok) {
    if (cmdCtx.error === 'CLIENT_VERSION_UNSUPPORTED') {
      callback?.({ success: false, error: 'CLIENT_VERSION_UNSUPPORTED' });
      return;
    }
    // NOT_IN_ROOM/INVALID_PAYLOAD: Engine-Handler prüft Membership ohnehin.
  }

  // BASIS-STANDARDS (B): gemeinsamer Guard — wirksames Recht aus der DB
  // (Grants/Revocations wirken sofort, auch bei verbundenen Sockets).
  // Wire-Kompatibilität (D): Bestehende Engines antworteten bei
  // Autorisierungs-Denial mit FORBIDDEN — die neue Permission-Denial-Codes
  // (ROLE_REQUIRED/NOT_AUTHORIZED) werden auf diese Legacy-Wire-Codes
  // abgebildet, damit keine Clients brechen.
  const perm = await requireGamePermission(args.socket, args.permission ?? 'BUZZER_CONTROL');
  if (!perm.ok) {
    const wireError = perm.error === 'NOT_IN_ROOM' ? 'NOT_IN_ROOM' : 'FORBIDDEN';
    const appError = wireErrorToAppError(wireError, { context: { action: args.action } });
    callback?.({ success: false, error: wireError, code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
    return;
  }

  const finish = (result: { success: boolean; error?: string; [k: string]: unknown }, replayed?: boolean) => {
    if (!result.success && result.error) {
      const appError = wireErrorToAppError(String(result.error), { context: { action: args.action } });
      callback?.({ ...result, code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId, ...(replayed ? { replayed: true } : {}) });
    } else {
      callback?.({ ...result, ...(replayed ? { replayed: true } : {}) });
    }
  };

  if (cmdCtx.ok && cmdCtx.ctx.commandMode) {
    try {
      const receipted = await runReceipted<EngineActionResult>(prisma, {
        roomId: cmdCtx.ctx.roomId,
        commandId: cmdCtx.ctx.commandId!,
        actor: { actorId: cmdCtx.ctx.actorId, actorRole: perm.role },
        action: toReceiptAction(args.action),
        payload: args.payload,
        // Audit PR14, 14-02/14-03: mitgesendete Versionserwartung wird
        // serverseitig gegen die aktuelle Room-Revision geprüft.
        stateVersion: cmdCtx.ctx.envelope?.stateVersion,
        mutate: () => awaitEngineResult((onResult) => args.handler(onResult)),
        toResponse: (d) => d,
      });
      if (receipted.success) {
        finish(receipted.data, receipted.replayed);
      } else if ('resyncRequired' in receipted && receipted.resyncRequired) {
        // Audit PR14, 14-02: Die ursprüngliche Absicht hat bereits gewirkt,
        // die Erfolgs-Quittung ging verloren. Neue Ausführung verboten —
        // kontrollierter Resync statt Doppelwirkung.
        const appError = wireErrorToAppError(receipted.error, { context: { action: args.action } });
        callback?.({ success: false, error: receipted.error, resyncRequired: true, code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
      } else {
        callback?.({ success: false, error: receipted.error, ...(receipted.replayed ? { replayed: true } : {}) });
      }
    } catch (error) {
      logger.error(`receipted action ${args.action} threw`, { error });
      const wireError = gameErrorCode(error);
      const appError = wireErrorToAppError(wireError, { internalDetail: error, context: { action: args.action } });
      callback?.({ success: false, error: wireError, code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
    }
    return;
  }

  // Legacy-Pfad (kein Absichtstoken): bestehendes Verhalten.
  try {
    const result = await awaitEngineResult((onResult) => args.handler(onResult));
    finish(result);
  } catch (error) {
    logger.error(`action ${args.action} threw`, { error });
    const wireError = gameErrorCode(error);
    const appError = wireErrorToAppError(wireError, { internalDetail: error, context: { action: args.action } });
    callback?.({ success: false, error: wireError, code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
  }
}

// Mapping Engine-Aktion → Receipt-Aktion (§2.3/CRITICAL_COMMAND_ACTIONS).
function toReceiptAction(action: string): import('./commands.js').CriticalCommandAction {
  switch (action) {
    case 'buzz': return 'BUZZ';
    case 'stealBuzz': case 'steal_buzz': return 'STEAL_BUZZ';
    case 'judge': case 'stealJudge': case 'steal_judge': return 'JUDGE';
    case 'reveal': return 'REVEAL';
    case 'next': case 'advance': return 'ROUND_ADVANCE';
    case 'fieldOpen': case 'field_open': return 'FIELD_OPEN';
    case 'boardSwitch': case 'board_switch': return 'BOARD_SWITCH';
    case 'answer': case 'submit': return 'ANSWER_SUBMIT';
    case 'joker': case 'joker5050': case 'joker5050_use': case 'jokerSpy': case 'jokerRisk': return 'JOKER_USE';
    case 'start': return 'GAME_START';
    case 'pause': return 'GAME_PAUSE';
    case 'resume': return 'GAME_RESUME';
    case 'abort': case 'end': return 'GAME_ABORT';
    default: return 'ROUND_ADVANCE';
  }
}
