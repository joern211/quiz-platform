import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { logger } from '../../observability/logger.js';
import { gameErrorCode } from '../core/errors.js';
import { WerIstDasJudgeSchema, WER_IST_DAS_EVENTS } from './contracts.js';
import { werIstDasGame } from './engine.js';
import { getGameEngineContract } from '../core/engineContract.js';
import { InvalidGameAction } from './state.js';
import { runGuardedCriticalAction, receiptPayloadWithoutRoomCode, type EngineActionResult } from '../core/receiptedAction.js';
import type { GamePermission } from '@quiz/shared';

type Ack = (result: { success: boolean; error?: string; state?: unknown }) => void;
const readPayload = z.object({ roomCode: z.string().regex(/^\d{3}-\d{3}$/).optional() });
// Audit PR14, 14-03 (Nacharbeit): Die Envelope-Felder werden VOLLSTÄNDIG
// ERLAUBT UND ERHALTEN — nie still entfernt. Die zentrale Prüfung
// (resolveCommandContextForSocket → CommandEnvelope-Schema) validiert
// Widersprüche, negative Werte und Typen VOR jeder Mutation
// (INVALID_PAYLOAD). Wäre hier das Feld gestrichen, sähe die zentrale
// Prüfung stateVersion:-1 nie (Audit-Beleg: REVIEW_STRIPPED_VERSION).
// Legacy-Kompatibilität = Feld FEHLT (optional); vorhandene ungültige
// Werte werden abgelehnt, nicht als Legacy gedeutet.
const emptyEnveloped = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/).optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});
const publicError = (error: unknown) => error instanceof InvalidGameAction ? error.code : gameErrorCode(error);

// BASIS-STANDARDS: §2.3-Recht je WID-Aktion. Die Engine prüft zusätzlich die
// Rollen-Grenze (buzz: PLAYER-only, inkl. HOST_CANNOT_PLAY_OWN-Round-Logik),
// Phase und CAS — Defense in Depth.
const WID_ACTION_PERMISSION: Record<string, GamePermission> = {
  open: 'BUZZER_CONTROL',      // Host öffnet den Buzzer
  buzz: 'BUZZER_CONTROL',      // Spieler-Buzzer
  hint: 'ROUND_ADVANCE',       // Spielzugangsteuerung (keine eigene Permission)
  judge: 'JUDGE_ANSWER',
  reveal: 'REVEAL_CONTENT',
  next: 'ROUND_ADVANCE',
};

export function registerWerIstDasEvents(io: Server, socket: Socket) {
  const actions = [
    [WER_IST_DAS_EVENTS.OPEN, 'open', emptyEnveloped],
    [WER_IST_DAS_EVENTS.BUZZ, 'buzz', emptyEnveloped],
    [WER_IST_DAS_EVENTS.HINT, 'hint', emptyEnveloped],
    [WER_IST_DAS_EVENTS.JUDGE, 'judge', z.intersection(WerIstDasJudgeSchema, emptyEnveloped)],
    [WER_IST_DAS_EVENTS.REVEAL, 'reveal', emptyEnveloped],
    [WER_IST_DAS_EVENTS.NEXT, 'next', emptyEnveloped],
  ] as const;
  for (const [event, action, schema] of actions) {
    socket.on(event, (data: unknown, callback?: Ack) => {
      void (async () => {
      const parsed = schema.safeParse(data);
      if (!parsed.success) { callback?.({ success: false, error: 'INVALID_PAYLOAD' }); return; }
      try {
        // Guard: wirksames Recht aus der DB + Receipt-Modus (Absichtstoken)
        // + Protokollversions-Check. Die Engine bleibt der Fach-Kontext.
        await runGuardedCriticalAction({
    gameSlug: 'wer-ist-das',
          io,
          socket,
          action,
          permission: WID_ACTION_PERMISSION[action],
          payload: parsed.data,
          receiptPayload: receiptPayloadWithoutRoomCode(parsed.data),
          handler: (onResult: (r: EngineActionResult) => void) =>
            getGameEngineContract('wer-ist-das')!.handleCommand({ io, socket }, { action, payload: parsed.data })
              .then((result) => onResult(result as EngineActionResult))
              .catch((error: unknown) => onResult({ success: false, error: publicError(error) })),
        }, callback as (result: { success: boolean; error?: string; [k: string]: unknown }) => void);
      } catch (error) {
        logger.error(`${event} failed`, { error });
        callback?.({ success: false, error: publicError(error) });
      }
      })();
    });
  }
  socket.on(WER_IST_DAS_EVENTS.RESYNC, async (data: unknown, callback?: Ack) => {
    const parsed = readPayload.safeParse(data);
    if (!parsed.success) { callback?.({ success: false, error: 'INVALID_PAYLOAD' }); return; }
    try { callback?.(await werIstDasGame.resync(socket, parsed.data.roomCode)); }
    catch (error) {
      logger.error('weristdas:resync failed', { error });
      callback?.({ success: false, error: publicError(error) });
    }
  });
}
