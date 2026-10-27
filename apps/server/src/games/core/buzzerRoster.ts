import type { Prisma } from '@prisma/client';
import { roomPolicy } from '../../rooms/core.js';
import { createBuzzerState, openBuzzer } from './buzzer.js';
import { CoreRuleError } from './runtimePrimitives.js';

/** Pin the roster at the first input opening, never again on a wrong-answer reopen. */
export async function openRoundBuzzerForRoom(db: Prisma.TransactionClient, roomId: string, participantIds: string[]) {
  const room = await db.room.findUniqueOrThrow({ where: { id: roomId } });
  const players = await db.participation.findMany({ where: { roomId, id: { in: participantIds }, role: 'PLAYER', admission: 'ACTIVE',
    leftAt: null, kickedAt: null, bannedAt: null }, select: { id: true, teamId: true } });
  const eligiblePlayerIds = players.map(p => p.id);
  if (!eligiblePlayerIds.length) throw new CoreRuleError('NO_ELIGIBLE_PLAYERS');
  if (roomPolicy(room).teamMode === 'OFF') return openBuzzer(createBuzzerState(), { mode: 'SELECTED', eligiblePlayerIds });
  const teams = await db.roomTeam.findMany({ where: { roomId }, select: { id: true } });
  if (players.some(p => !p.teamId || !teams.some(t => t.id === p.teamId))) throw new CoreRuleError('TEAM_CONFIGURATION_INVALID');
  return openBuzzer(createBuzzerState(), { mode: 'TEAM', eligiblePlayerIds,
    teamByPlayer: Object.fromEntries(players.map(p => [p.id, p.teamId!])) });
}
