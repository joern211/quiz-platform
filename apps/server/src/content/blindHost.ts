import type { Room } from '@prisma/client';
import { ContentError, type ContentDb } from './core.js';
export function blindSetup(setup: unknown): boolean {
  return !!setup && typeof setup === 'object' && (setup as { contentSelection?: { visibility?: unknown } }).contentSelection?.visibility === 'BLIND_HOST';
}
export function blindRoom(room: Pick<Room, 'contentVisibility'>): boolean { return room.contentVisibility === 'BLIND_HOST'; }
export async function activeBlindHost(db: ContentDb, userId: string): Promise<boolean> {
  return !!await db.room.findFirst({ where: { hostUserId: userId, contentVisibility: 'BLIND_HOST', status: { in: ['CREATED', 'LOBBY', 'RUNNING'] }, AND: [{ OR: [{ lifecycle: null }, { lifecycle: { notIn: ['CLOSED', 'EXPIRED'] } }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }] }, select: { id: true } });
}
export async function assertBlindEditorialAccess(db: ContentDb, sessionId: string | null) {
  if (!sessionId) return;
  const session = await db.session.findFirst({ where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } } });
  if (session && await activeBlindHost(db, session.userId)) throw new ContentError('BLIND_HOST_CONTENT_HIDDEN', 403);
}
export async function assertBlindRoomCreation(db: ContentDb, userId: string, blind: boolean) {
  const other = await db.room.findMany({ where: { hostUserId: userId, status: { in: ['CREATED', 'LOBBY', 'RUNNING'] }, AND: [{ OR: [{ lifecycle: null }, { lifecycle: { notIn: ['CLOSED', 'EXPIRED'] } }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }] }, select: { contentVisibility: true } });
  if (other.some(r => r.contentVisibility === 'BLIND_HOST') || blind && other.length > 0) throw new ContentError('BLIND_HOST_OTHER_ACTIVE_ROOM', 409);
}
