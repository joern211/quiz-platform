import { logger } from '../../observability/logger.js';
import { prisma } from '../../persistence/prisma.js';
import { actionLimiter, type LimitDecision, type LimitGroup } from './actionLimits.js';

export interface RateLimitedResponse {
  success: false; error: 'RATE_LIMITED'; code: 'RATE_LIMITED'; messageKey: 'RATE_LIMITED'; traceId: string;
  retryable: true; details: { retryAfterMs: number };
}

/**
 * Early refusal for an already authorised identity. It produces no fachliche Mutation,
 * no receipt and no private data; the diagnostic line is written once per rejection streak.
 * Returns null while the budget lasts.
 */
export function refusalFor(decision: Extract<LimitDecision, { ok: false }>, roomId: string, group: LimitGroup, action: string): RateLimitedResponse {
  if (decision.firstRejection) logger.warn('[APP_ERROR] RATE_LIMITED RATE_LIMITED', { traceId: decision.traceId, roomId, group, action, retryAfterMs: decision.retryAfterMs });
  return { success: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED', messageKey: 'RATE_LIMITED', traceId: decision.traceId, retryable: true, details: { retryAfterMs: decision.retryAfterMs } };
}

export function limitAction(roomId: string, participantId: string, group: LimitGroup, action: string): RateLimitedResponse | null {
  const decision = actionLimiter.consume(roomId, participantId, group);
  return decision.ok ? null : refusalFor(decision, roomId, group, action);
}

/** A command this participant already sent is a retry (stored answer / in progress), not a new intent. */
export async function isOwnKnownIntent(roomId: string, commandId: string, actorId: string): Promise<boolean> {
  return !!await prisma.commandReceipt.findFirst({ where: { roomId, commandId, actorId }, select: { commandId: true } });
}

/** Read paths (resync, result read): keyed by the server-set socket identity; unsubscribed sockets are not tracked. */
export function limitSocketRead(socket: { data: Record<string, unknown> }, action: string): RateLimitedResponse | null {
  const { roomId, participationId } = socket.data;
  if (typeof roomId !== 'string' || typeof participationId !== 'string') return null;
  return limitAction(roomId, participationId, 'READ', action);
}
