import type { Room } from '@prisma/client';
import { prisma } from '../../persistence/prisma.js';
import { roomPolicy } from '../../rooms/core.js';

/** The player default permits buzzing; only host/delegated controls may change it. */
export async function isBuzzerController(room: Room, userId: string | null): Promise<boolean> {
  return userId === room.hostUserId || !!userId && roomPolicy(room).coHostEnabled && !!await prisma.roomPermissionGrant.findFirst({
    where: { roomId: room.id, userId, permission: 'BUZZER_CONTROL', direction: 'GRANT', revokedAt: null },
  });
}
