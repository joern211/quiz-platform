import type { Socket } from 'socket.io';
import { actionLimiter } from './actionLimits.js';
import { limitAction, refusalFor } from './limitGuard.js';

/**
 * First, database-free admission stage for game sockets (G4 D, hardened after the independent review).
 *
 * It runs as socket middleware, before any handler: the only inputs are the server-set socket identity
 * (room + participation), the event name and counters in memory. It grants no right whatsoever — every
 * admitted packet still goes through the authoritative checks (membership, session, device binding,
 * grants/revocations, room, phase, receipts). Its purpose is to bound the work that happens BEFORE the
 * finer budgets can decide: once an identity is exhausted, further packets cost no database read and no
 * log line, however many arrive.
 *
 *  - REQUEST: every game packet of the identity (burst 40, 12/s sustained).
 *  - DENIED:  packets answered with an authorisation refusal count here (see below); once exhausted the
 *             identity's further packets are turned away early, too.
 * The key is room + participation, so more tabs, a reconnect or fresh command ids share one budget, other
 * participants and other rooms are untouched, and no IP is involved (shared WLAN).
 */
const ADMITTED = (event: string) => /^(geo|jeopardy|weristdas|game):/.test(event) || event === 'room:command';
const AUTHORISATION_REFUSALS = new Set(['FORBIDDEN', 'NOT_AUTHORIZED', 'UNAUTHORIZED', 'ROLE_REQUIRED', 'NO_PARTICIPATION', 'VIEWERS_CANNOT_MODIFY', 'OWNERSHIP_REQUIRED', 'NOT_IN_ROOM', 'OWNER_REQUIRED']);

const isAuthorisationRefusal = (response: unknown): boolean => {
  if (!response || typeof response !== 'object') return false;
  const { success, error, code } = response as { success?: unknown; error?: unknown; code?: unknown };
  return success === false && (AUTHORISATION_REFUSALS.has(String(error)) || AUTHORISATION_REFUSALS.has(String(code)));
};

export function registerRequestAdmission(socket: Socket): void {
  socket.use((packet, next) => {
    const [event, ...args] = packet;
    const { roomId, participationId } = socket.data as { roomId?: unknown; participationId?: unknown };
    // No server-resolved identity (not subscribed): nothing is tracked and the handlers refuse it without database work.
    if (typeof event !== 'string' || !ADMITTED(event) || typeof roomId !== 'string' || typeof participationId !== 'string') return next();
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] as (response: unknown) => void : undefined;
    const limited = limitAction(roomId, participationId, 'REQUEST', event);
    if (limited) { ack?.({ ...limited }); return; }
    const denied = actionLimiter.consume(roomId, participationId, 'DENIED', false);
    if (!denied.ok) { ack?.({ ...refusalFor(denied, roomId, 'DENIED', event) }); return; }
    if (ack) packet[packet.length - 1] = (response: unknown) => {
      if (isAuthorisationRefusal(response)) actionLimiter.consume(roomId, participationId, 'DENIED');
      ack(response);
    };
    next();
  });
}
