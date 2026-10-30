// ============================================================
// Error Contract Helper (BASIS-STANDARDS, Master §12.2/§12.13)
// ============================================================
// Baut AppError-Antworten (code, messageKey, traceId, optional
// details/retryable) und koppelt die traceId kontrolliert an den
// Server-Log. Interne Details (Stack, SQL, Pfade, Tokens) bleiben
// AUSSERHALB der Antwort — sie gehen nur in den Log (serverseitig).
//
// Kompatibilität: die bestehenden Wire-Codes (z.B. 'STATE_CONFLICT',
// 'NOT_ENOUGH_PLAYERS') bleiben als `code` erhalten, damit Clients
// weiter funktionieren; `messageKey` ist der neue, lokalisierte
// Schlüssel. Das lesbare `message`-Feld wird im Kompatibilitätsfenster
// nur für bekannte, client-gelesene Codes gesetzt.
// ============================================================

import { randomUUID } from 'node:crypto';
import { logger } from '../../observability/logger.js';
import type { AppError, ErrorCode } from '@quiz/shared';

const TYPED_ERRORS = new Set(['CoreRuleError', 'RoomError', 'InvalidGameAction', 'GameStateConflictError', 'ConfigSnapshotError']);
const MESSAGE_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Diagnostic-safe description of a failure for the server log. Typed application errors
 * carry a stable code as their message; for anything else (database, library, runtime) only
 * the class name and a short machine code are kept — their messages can embed query
 * arguments, file paths, tokens or answers, and "only in the server log" is no excuse.
 */
export function describeInternal(detail: unknown): Record<string, unknown> {
  if (!(detail instanceof Error)) return { type: typeof detail };
  const { code } = detail as { code?: unknown };
  const kind = detail.constructor?.name ?? detail.name;
  return {
    name: kind,
    ...(typeof code === 'string' && MESSAGE_KEY.test(code) ? { code } : {}),
    ...(TYPED_ERRORS.has(kind) && MESSAGE_KEY.test(detail.message) ? { message: detail.message } : {}),
  };
}

/**
 * Erzeugt einen AppError und loggt ihn kontrolliert (traceId verbindet
 * Antwort und Serverlog; der Client erhält dadurch KEINE zusätzlichen
 * Rechte). `internalDetail` geht NUR in den Log, nie in die Antwort.
 */
export function buildAppError(
  code: string,
  messageKey: string,
  opts: {
    message?: string;
    traceId?: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
    /** Nur Log: interne Fehler, nie in die Antwort. */
    internalDetail?: unknown;
    context?: Record<string, unknown>;
  } = {},
): AppError {
  const traceId = opts.traceId ?? randomUUID();
  // The wire never carries free text: a message key is a stable identifier or nothing.
  const safeKey = MESSAGE_KEY.test(messageKey) ? messageKey : messageKey.startsWith('VALIDATION_ERROR') ? 'INVALID_PAYLOAD' : 'INTERNAL_ERROR';
  const logLine = `[APP_ERROR] ${code} ${safeKey}`, meta = { traceId, ...opts.context, ...(opts.internalDetail !== undefined ? { internalDetail: describeInternal(opts.internalDetail) } : {}) };
  if (code === 'INTERNAL_ERROR') logger.error(logLine, meta); else logger.warn(logLine, meta);
  const error: AppError = { code, messageKey: safeKey, traceId };
  if (opts.message !== undefined) error.message = opts.message;
  if (opts.details !== undefined) error.details = opts.details;
  if (opts.retryable !== undefined) error.retryable = opts.retryable;
  return error;
}

/**
 * Mapping bestehender Wire-Codes → AppError-Code (Dokumentation der
 * Abbildung; stabile Codes bleiben erhalten, neue Codes ergänzend).
 * `INTERNAL_ERROR` fängt alles, was nicht publiziert werden darf.
 */
const WIRE_TO_ERROR_CODE: Record<string, ErrorCode> = {
  STATE_CONFLICT: 'STALE_STATE',
  STALE_ROUND: 'STALE_STATE',
  STALE_ATTEMPT: 'STALE_STATE',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  NOT_ALL_READY: 'NOT_ALL_READY',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  GAME_NOT_FOUND: 'GAME_NOT_IMPLEMENTED',
  GAME_NOT_IMPLEMENTED: 'GAME_NOT_IMPLEMENTED',
  GAME_NOT_RUNNING: 'GAME_NOT_RUNNING',
  GAME_ALREADY_STARTED: 'GAME_ALREADY_STARTED',
  GAME_NOT_STARTABLE: 'GAME_NOT_STARTABLE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  INVALID_CONFIG: 'INVALID_PAYLOAD',
  INVALID_OPTION: 'INVALID_PAYLOAD',
  INVALID_PHASE: 'INVALID_PHASE',
  INVALID_GAME_STATE: 'RECOVERY_REQUIRED',
  INVALID_TIMER_STATE: 'RECOVERY_REQUIRED',
  TURN_OWNER_CONFLICT: 'RECOVERY_REQUIRED',
  INVALID_ROUND_INDEX: 'RECOVERY_REQUIRED',
  INVALID_SCORE: 'RECOVERY_REQUIRED',
  STATE_INVARIANT_FAILED: 'RECOVERY_REQUIRED',
  COMMAND_UNSUPPORTED: 'INVALID_PAYLOAD',
  WRONG_GAME: 'SCOPE_VIOLATION',
  PLAYER_NOT_IN_ROUND: 'NO_PARTICIPATION',
  JOKER_ALREADY_USED: 'ALREADY_PROCESSED',
  NOT_ALL_ANSWERED: 'INVALID_PHASE',
  PHASE_NOT_SELECTING: 'INVALID_PHASE',
  PHASE_NOT_BUZZ_OPEN: 'INVALID_PHASE',
  PHASE_NOT_BUZZ_LOCKED: 'INVALID_PHASE',
  PHASE_NOT_STEAL_OPEN: 'INVALID_PHASE',
  PHASE_NOT_STEAL_LOCKED: 'INVALID_PHASE',
  PHASE_NOT_FIELD_DONE: 'INVALID_PHASE',
  PHASE_NOT_BOARD_COMPLETE: 'INVALID_PHASE',
  INVALID_SETUP: 'INVALID_PAYLOAD',
  ALREADY_ANSWERED: 'ALREADY_PROCESSED',
  PLAYER_EXCLUDED: 'ALREADY_PROCESSED',
  TIME_EXPIRED: 'INVALID_PHASE',
  COMMAND_CONFLICT: 'COMMAND_CONFLICT',
  COMMAND_IN_PROGRESS: 'ALREADY_PROCESSED',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  LOCKED_AFTER_START: 'ROOM_LOCKED',
  UNSUPPORTED_ENGINE_VERSION: 'RECOVERY_REQUIRED',
  CLIENT_VERSION_UNSUPPORTED: 'CLIENT_VERSION_UNSUPPORTED',
  CONFIG_SNAPSHOT_INVALID: 'RECOVERY_REQUIRED',
  COMMAND_STATE_ADVANCED: 'RECOVERY_REQUIRED',
  COMMAND_OWNERSHIP_LOST: 'RECOVERY_REQUIRED',
  INSUFFICIENT_ROLE: 'NOT_AUTHORIZED',
  UNAUTHORIZED: 'NOT_AUTHORIZED',
  FORBIDDEN: 'NOT_AUTHORIZED',
  NOT_IN_ROOM: 'RESOURCE_NOT_ACCESSIBLE',
  WRONG_ROOM: 'WRONG_ROOM',
  NO_PARTICIPATION: 'NO_PARTICIPATION',
  VIEWERS_CANNOT_MODIFY: 'SCOPE_VIOLATION',
  OWNERSHIP_REQUIRED: 'OWNERSHIP_REQUIRED',
};

/**
 * Übersetzt einen (vielleicht internen) Fehlercode in einen
 * publishbaren AppError. Unbekannte/interne Codes → INTERNAL_ERROR
 * ohne Details (keine Stack-/SQL-/Pfad-Ausgabe).
 */
export function wireErrorToAppError(
  wireCode: string,
  opts: { context?: Record<string, unknown>; internalDetail?: unknown } = {},
): AppError {
  const code = WIRE_TO_ERROR_CODE[wireCode] ?? (wireCode.startsWith('VALIDATION_ERROR') ? 'INVALID_PAYLOAD' : 'INTERNAL_ERROR');
  const publishable = WIRE_TO_ERROR_CODE[wireCode] !== undefined || wireCode in WIRE_TO_ERROR_CODE;
  return buildAppError(code, wireCode, {
    context: opts.context,
    internalDetail: publishable ? undefined : opts.internalDetail,
    retryable: code === 'REVISION_CONFLICT' || code === 'ALREADY_PROCESSED' ? false : undefined,
  });
}
