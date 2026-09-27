import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { logger } from '../../observability/logger.js';
import { gameErrorCode } from '../core/errors.js';
import { WerIstDasJudgeSchema, WER_IST_DAS_EVENTS } from './contracts.js';
import { werIstDasGame } from './engine.js';

type Ack = (result: { success: boolean; error?: string; state?: unknown }) => void;
const empty = z.object({}).strict();

export function registerWerIstDasEvents(io: Server, socket: Socket) {
  const actions = [
    [WER_IST_DAS_EVENTS.OPEN, 'open', empty],
    [WER_IST_DAS_EVENTS.BUZZ, 'buzz', empty],
    [WER_IST_DAS_EVENTS.HINT, 'hint', empty],
    [WER_IST_DAS_EVENTS.JUDGE, 'judge', WerIstDasJudgeSchema.strict()],
    [WER_IST_DAS_EVENTS.REVEAL, 'reveal', empty],
    [WER_IST_DAS_EVENTS.NEXT, 'next', empty],
  ] as const;
  for (const [event, action, schema] of actions) {
    socket.on(event, async (data: unknown, callback?: Ack) => {
      const parsed = schema.safeParse(data);
      if (!parsed.success) { callback?.({ success: false, error: 'INVALID_PAYLOAD' }); return; }
      try {
        callback?.(await werIstDasGame.act(io, socket, action, action === 'judge' ? parsed.data : undefined));
      } catch (error) {
        logger.error(`${event} failed`, { error });
        callback?.({ success: false, error: gameErrorCode(error) });
      }
    });
  }
  socket.on(WER_IST_DAS_EVENTS.RESYNC, async (data: unknown, callback?: Ack) => {
    if (!empty.safeParse(data).success) { callback?.({ success: false, error: 'INVALID_PAYLOAD' }); return; }
    try { callback?.(await werIstDasGame.resync(socket)); }
    catch (error) {
      logger.error('weristdas:resync failed', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  });
}
