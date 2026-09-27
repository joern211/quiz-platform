import type { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { roomChannel } from '../../sockets/channel.js';
import { authorizeGameContext, type GameRole } from '../core/access.js';
import { recordScoreMutation } from '../core/score.js';
import { finishRunningGame, loadGameState, saveGameStateIfRevision, upsertGameState } from '../core/state.js';
import { WerIstDasPhase, WerIstDasSetupSchema, type WerIstDasSetup } from './contracts.js';
import { projectWerIstDas } from './resync.js';
import { activateHint, buzz, createWerIstDasState, judge, nextRound, openRoundBuzzer, revealRound,
  type WerIstDasState } from './state.js';

type Ack = { success: boolean; error?: string; state?: ReturnType<typeof projectWerIstDas> };
type Action = 'open' | 'buzz' | 'hint' | 'judge' | 'reveal' | 'next';

async function sendProjections(io: Server, roomId: string, state: WerIstDasState, setup: WerIstDasSetup) {
  for (const socket of await io.in(roomChannel(roomId)).fetchSockets()) {
    const identity = socket.data as { roomId?: string; role?: string; participationId?: string };
    if (identity.roomId !== roomId || !['MODERATOR', 'PLAYER', 'VIEWER'].includes(identity.role ?? '')) continue;
    socket.emit('weristdas:update', projectWerIstDas(state, setup, identity.role as GameRole, identity.participationId));
  }
}

export const werIstDasGame = {
  async initialize(io: Server, room: { id: string; code: string; hostUserId?: string; setupSnapshotJson: string | null }) {
    const setup = WerIstDasSetupSchema.parse(JSON.parse(room.setupSnapshotJson ?? '{}'));
    if (new Set(setup.rounds.map(r => r.id)).size !== setup.rounds.length) throw new Error('INVALID_SETUP');
    // Only existing images owned by the room host may be used in a new game.
    const savedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id }, select: { hostUserId: true } });
    const assets = await prisma.mediaAsset.findMany({
      where: { id: { in: setup.rounds.map(r => r.imageAssetId) }, type: 'image', uploadedBy: savedRoom.hostUserId },
      select: { id: true },
    });
    if (new Set(assets.map(a => a.id)).size !== new Set(setup.rounds.map(r => r.imageAssetId)).size) {
      throw new Error('INVALID_SETUP');
    }
    const players = await prisma.participation.findMany({ where: { roomId: room.id, role: 'PLAYER' } });
    const names = Object.fromEntries(players.map(p => [p.id, p.displayName]));
    const scores = Object.fromEntries(players.map(p => [p.id, p.score]));
    const state = createWerIstDasState(setup.rounds.length, names, scores);
    await upsertGameState({ roomId: room.id, state, phase: state.phase });
    await sendProjections(io, room.id, state, setup);
  },

  async act(io: Server, socket: Socket, action: Action, payload?: { result?: 'BOTH_CORRECT' | 'ONE_CORRECT' | 'WRONG' }): Promise<Ack> {
    const auth = await authorizeGameContext(socket, {
      gameSlug: 'weristdas', roles: action === 'buzz' ? ['PLAYER'] : ['MODERATOR'],
      requireParticipation: true, requireRunning: true,
    });
    if (!auth.ok) return { success: false, error: auth.error };
    const roomId = auth.actor.roomId;
    const setup = WerIstDasSetupSchema.parse(JSON.parse(auth.room.setupSnapshotJson));
    const loaded = await loadGameState<WerIstDasState>(roomId);
    if (!loaded) return { success: false, error: 'GAME_NOT_FOUND' };
    let state = loaded.state;
    let scoreMutation: { playerId: string; delta: number; score: number } | undefined;
    if (action === 'open') state = openRoundBuzzer(state);
    if (action === 'buzz') state = buzz(state, auth.actor.participationId!);
    if (action === 'hint') state = activateHint(state);
    if (action === 'judge') {
      const judged = judge(state, payload!.result!);
      state = judged.state;
      scoreMutation = { playerId: judged.playerId, delta: judged.delta, score: state.scores[judged.playerId] };
    }
    if (action === 'reveal') state = revealRound(state);
    if (action === 'next') {
      if (state.phase !== WerIstDasPhase.REVEAL) return { success: false, error: 'INVALID_PHASE' };
      if (state.roundIndex + 1 === state.roundCount) {
        const ended = await werIstDasGame.end(io, auth.room);
        return { success: true, state: projectWerIstDas(ended.state, setup, auth.actor.role, auth.actor.participationId) };
      }
      state = nextRound(state, setup.rounds[state.roundIndex].id);
    }
    await prisma.$transaction(async tx => {
      await saveGameStateIfRevision(tx, { roomId, expectedRevision: loaded.revision, state, phase: state.phase });
      if (scoreMutation) await recordScoreMutation(tx, {
        roomId, participationId: scoreMutation.playerId, score: scoreMutation.score,
        delta: scoreMutation.delta, reason: `weristdas:${payload!.result!.toLowerCase()}`,
        roundIndex: state.roundIndex,
      });
    });
    await sendProjections(io, roomId, state, setup);
    return { success: true, state: projectWerIstDas(state, setup, auth.actor.role, auth.actor.participationId) };
  },

  async resync(socket: Socket): Promise<Ack> {
    const auth = await authorizeGameContext(socket, {
      gameSlug: 'weristdas', roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
      requireParticipation: true,
    });
    if (!auth.ok) return { success: false, error: auth.error };
    const loaded = await loadGameState<WerIstDasState>(auth.actor.roomId);
    if (!loaded) return { success: false, error: 'GAME_NOT_FOUND' };
    const setup = WerIstDasSetupSchema.parse(JSON.parse(auth.room.setupSnapshotJson));
    return { success: true, state: projectWerIstDas(loaded.state, setup, auth.actor.role, auth.actor.participationId) };
  },

  async end(io: Server, room: { id: string; code: string; setupSnapshotJson: string | null }) {
    const result = await finishRunningGame<WerIstDasState>({
      roomId: room.id, nextState: state => ({ ...state, buzzer: { ...state.buzzer, open: false } }),
    });
    if (result.ended) {
      const setup = WerIstDasSetupSchema.parse(JSON.parse(room.setupSnapshotJson ?? '{}'));
      await sendProjections(io, room.id, result.state, setup);
      io.to(roomChannel(room.id)).emit('game:end', { roomCode: room.code, status: 'ENDED', runPhase: 'RESULTS' });
    }
    return result;
  },
};
