import type { GameActionContext } from '../games/registry.js';
import { prisma } from '../persistence/prisma.js';
import { assertCommandMutation } from '../games/core/commandExecution.js';
import { requireGamePermission } from '../games/core/permissions.js';
import { feed } from './core.js';
import { changed } from './socket.js';
import { roomChannel } from '../sockets/channel.js';
import { pauseTimer, resumeTimer } from '../games/core/runtimePrimitives.js';
import { assertGameInvariants } from '../games/core/invariants.js';
import { saveGameStateIfRevision } from '../games/core/state.js';

/** Engines without wall-clock timers freeze their complete state atomically. */
export async function pauseUntimedGame(context: GameActionContext, pause: boolean) {
  const { io, socket, roomCode, callback } = context;
  const permission = await requireGamePermission(socket, 'GAME_PAUSE');
  if (!permission.ok) { callback?.({ success: false, error: 'NOT_AUTHORIZED' }); return; }
  const room = await prisma.room.findUniqueOrThrow({ where: { code: roomCode }, include: { gameDefinition: true } });
  if (room.id !== permission.roomId) { callback?.({ success: false, error: 'WRONG_ROOM' }); return; }
  try {
    await prisma.$transaction(async tx => {
      await assertCommandMutation(tx, room.id);
      const live = await tx.room.findUniqueOrThrow({ where: { id: room.id } });
      const row = await tx.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
      if (live.status !== 'RUNNING' || (pause ? row.phase === 'PAUSED' || row.phase === 'GAME_END' : row.phase !== 'PAUSED')) throw Error('INVALID_PHASE');
      const state = JSON.parse(row.stateJson);
      const next = pause ? { ...state, phase: 'PAUSED', _roomPause: state } : state._roomPause;
      if (!next || typeof next.phase !== 'string') throw Error('INVALID_PAUSE_STATE');
      if (state.timer) next.timer = pause ? pauseTimer(state.timer, Date.now()) : resumeTimer(state.timer, Date.now());
      assertGameInvariants(room.gameDefinition.slug, next, next.phase);
      await saveGameStateIfRevision(tx, { gameSlug: room.gameDefinition.slug, roomId: room.id, expectedRevision: row.revision, phase: next.phase, state: next });
      await tx.room.update({ where: { id: room.id }, data: { runPhase: pause ? 'PAUSED' : next.phase, revision: { increment: 1 } } });
      await feed(tx, room.id, permission.actorId, pause ? 'PAUSE' : 'RESUME', pause ? 'Spiel pausiert' : 'Spiel fortgesetzt');
    });
    io.to(roomChannel(room.id)).emit(pause ? 'game:pause' : 'game:resume', { roomCode });
    changed(io, room.id);
    callback?.({ success: true });
  } catch (error) { callback?.({ success: false, error: error instanceof Error ? error.message : 'INTERNAL_ERROR' }); }
}
