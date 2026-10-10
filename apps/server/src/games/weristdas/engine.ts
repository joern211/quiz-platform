import type { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { roomChannel } from '../../sockets/channel.js';
import { authorizeGameContext, type GameRole } from '../core/access.js';
import { recordScoreMutation } from '../core/score.js';
import { finishRunningGame, loadGameState, saveGameStateIfRevision, upsertGameState } from '../core/state.js';
import { WerIstDasPhase, WerIstDasSetupSchema, WER_IST_DAS_ENGINE_VERSION, isV2Round,
  isSupportedEngineVersion,
  type WerIstDasSetup, type WerIstDasRound } from './contracts.js';
import { projectWerIstDas } from './resync.js';
import { resolveCanonicalSlug } from '@quiz/shared';
import { activateHint, buzz, createWerIstDasState, judge, nextRound, openRoundBuzzer, revealRound,
  InvalidGameAction, type WerIstDasState } from './state.js';

type Ack = { success: boolean; error?: string; state?: ReturnType<typeof projectWerIstDas> };
type Action = 'open' | 'buzz' | 'hint' | 'judge' | 'reveal' | 'next';

async function sendProjections(io: Server, roomId: string, state: WerIstDasState, setup: WerIstDasSetup) {
  for (const socket of await io.in(roomChannel(roomId)).fetchSockets()) {
    const identity = socket.data as { roomId?: string; role?: string; participationId?: string };
    if (identity.roomId !== roomId || !['MODERATOR', 'PLAYER', 'VIEWER'].includes(identity.role ?? '')) continue;
    socket.emit('weristdas:update', projectWerIstDas(state, setup, identity.role as GameRole, identity.participationId));
  }
}

/**
 * Validiert ein Setup serverseitig (Arbeitsauftrag §2B):
 * - v1: das (eine) Bild muss existieren, ein Bild sein, READY sein und dem
 *   Raum-Host gehören.
 * - v2: beide Originale müssen existieren/Bild/READY/Host-eigene sein UND das
 *   Spielbild muss zu GENAU diesen beiden Quellen gehören (derivedFrom
 *   enthält beide), ein Bild sein und READY sein (Fremd-IDs werden abgewiesen,
 *   damit kein Host fremde Asset-IDs in ein Setup einschleusen kann).
 * Fehler → INVALID_SETUP → game.ts rollt LOBBY→RUNNING zurück (kein halb
 * gestartetes Spiel).
 */
async function validateSetup(rounds: WerIstDasRound[], hostUserId: string): Promise<void> {
  const imageAssetIds: string[] = [];
  for (const round of rounds) {
    if (isV2Round(round)) {
      imageAssetIds.push(round.personAImageAssetId, round.personBImageAssetId, round.gameImageAssetId);
    } else {
      imageAssetIds.push(round.imageAssetId);
    }
  }
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: [...new Set(imageAssetIds)] } },
    select: { id: true, type: true, processStatus: true, uploadedBy: true, derivedFromAssetIds: true },
  });
  const byId = new Map(assets.map(a => [a.id, a]));
  for (const round of rounds) {
    if (isV2Round(round)) {
      const a = byId.get(round.personAImageAssetId);
      const b = byId.get(round.personBImageAssetId);
      const g = byId.get(round.gameImageAssetId);
      const okSource = (x?: { type: string; processStatus: string; uploadedBy: string | null }) =>
        Boolean(x && x.type === 'image' && x.processStatus === 'READY' && x.uploadedBy === hostUserId);
      if (!okSource(a) || !okSource(b)) throw new Error('INVALID_SETUP');
      if (round.personAImageAssetId === round.personBImageAssetId) throw new Error('INVALID_SETUP');
      // Spielbild: Bild + READY + gehört dem Host + leitet sich von genau
      // diesen beiden Quellen ab.
      if (!g || g.type !== 'image' || g.processStatus !== 'READY' || g.uploadedBy !== hostUserId) {
        throw new Error('INVALID_SETUP');
      }
      let sources: string[] = [];
      try { sources = JSON.parse(g.derivedFromAssetIds ?? '[]'); } catch { sources = []; }
      const expected = [round.personAImageAssetId, round.personBImageAssetId].sort();
      const actual = [...sources].sort();
      if (actual.length !== 2 || expected[0] !== actual[0] || expected[1] !== actual[1]) {
        throw new Error('INVALID_SETUP');
      }
    } else {
      const img = byId.get(round.imageAssetId);
      if (!img || img.type !== 'image' || img.processStatus !== 'READY' || img.uploadedBy !== hostUserId) {
        throw new Error('INVALID_SETUP');
      }
    }
  }
}

export const werIstDasGame = {
  async initialize(io: Server, room: { id: string; code: string; hostUserId?: string; setupSnapshotJson: string | null }) {
    const setup = WerIstDasSetupSchema.parse(JSON.parse(room.setupSnapshotJson ?? '{}'));
    if (new Set(setup.rounds.map(r => r.id)).size !== setup.rounds.length) throw new Error('INVALID_SETUP');
    // Serverseitige Setup-Validierung: Eigentum, Typ, Verarbeitungsstatus und
    // (v2) die Zuordnung des Spielbilds zu genau den beiden Quellen.
    // Fehler → INVALID_SETUP → game.ts rollt die LOBBY→RUNNING-Übergabe
    // zurück und löscht den Teil-Game-State (kein halb gestartetes Spiel).
    const savedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id }, select: { hostUserId: true } });
    await validateSetup(setup.rounds, savedRoom.hostUserId);
    // PR11-Nacharbeit E: Heilung an der kritischen Grenze. Wenn ein Prozess
    // zwischen Raumerstellung und der tmp-Bindung (POST /rooms) beendet wurde,
    // liegen die Composites noch unter 'tmp-<Host>'. Beim Spielstart werden
    // sie idempotent an den echten Raum gebunden — der Raum ist ohnehin
    // lauffähig (Startvalidierung prüft Eigentum + Provenienz, nicht roomId).
    try {
      const { bindSnapshotAssetsToRoom } = await import('../../media/lifecycle.js');
      await bindSnapshotAssetsToRoom(prisma, { roomId: room.id, hostUserId: savedRoom.hostUserId, snapshotJson: room.setupSnapshotJson ?? '{}' });
    } catch { /* Bindung ist eine Verbesserung, kein Start-Voraussetzung */ }
    const players = await prisma.participation.findMany({ where: { roomId: room.id, role: 'PLAYER' } });
    const names = Object.fromEntries(players.map(p => [p.id, p.displayName]));
    const scores = Object.fromEntries(players.map(p => [p.id, p.score]));
    const state = createWerIstDasState(setup.rounds.length, names, scores);
    // engineVersion beim Start pinnen (Regelwerk §5.22): Recovery nutzt die
    // exakt gleiche Version.
    await upsertGameState({ roomId: room.id, state, phase: state.phase, engineVersion: WER_IST_DAS_ENGINE_VERSION });
    await sendProjections(io, room.id, state, setup);
  },

  async act(io: Server, socket: Socket, action: Action, payload?: { result?: 'BOTH_CORRECT' | 'ONE_CORRECT' | 'WRONG' }): Promise<Ack> {
    const auth = await authorizeGameContext(socket, {
      gameSlug: resolveCanonicalSlug('wer-ist-das')!, roles: action === 'buzz' ? ['PLAYER'] : ['MODERATOR'],
      requireParticipation: true, requireRunning: true,
    });
    if (!auth.ok) return { success: false, error: auth.error };
    const roomId = auth.actor.roomId;
    const setup = WerIstDasSetupSchema.parse(JSON.parse(auth.room.setupSnapshotJson));
    const loaded = await loadGameState<WerIstDasState>(roomId);
    if (!loaded) return { success: false, error: 'GAME_NOT_FOUND' };
    // PR11-Nacharbeit D: Versions-Gate. Der persistierte State wurde von der
    // Engine-Version `loaded.engineVersion` geschrieben. v1 und v2 erzeugen
    // die gleiche State-Form und werden vom gemeinsamen Reader exakt gelesen;
    // eine unbekannte/höhere Version darf NICHT gedeutet werden → kontrollierter
    // Fehler statt falschem State.
    if (!isSupportedEngineVersion(loaded.engineVersion)) {
      throw new InvalidGameAction('UNSUPPORTED_ENGINE_VERSION');
    }
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
      gameSlug: resolveCanonicalSlug('wer-ist-das')!, roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
      requireParticipation: true,
    });
    if (!auth.ok) return { success: false, error: auth.error };
    const loaded = await loadGameState<WerIstDasState>(auth.actor.roomId);
    if (!loaded) return { success: false, error: 'GAME_NOT_FOUND' };
    // PR11-Nacharbeit D: Versions-Gate (siehe act()). Rejoin/Resync nach einem
    // Neustart liest denselben persistierten State — auch hier nur unterstützte
    // Engine-Versionen deuten.
    if (!isSupportedEngineVersion(loaded.engineVersion)) {
      throw new InvalidGameAction('UNSUPPORTED_ENGINE_VERSION');
    }
    const setup = WerIstDasSetupSchema.parse(JSON.parse(auth.room.setupSnapshotJson));
    return { success: true, state: projectWerIstDas(loaded.state, setup, auth.actor.role, auth.actor.participationId) };
  },

  async end(io: Server, room: { id: string; code: string; setupSnapshotJson: string | null }) {
    const setup = WerIstDasSetupSchema.parse(JSON.parse(room.setupSnapshotJson ?? '{}'));
    const result = await finishRunningGame<WerIstDasState>({
      roomId: room.id, nextState: state => ({ ...state, buzzer: { ...state.buzzer, open: false },
        playedRoundIds: state.revealed
          ? [...state.playedRoundIds, setup.rounds[state.roundIndex].id]
          : state.playedRoundIds }),
    });
    if (result.ended) {
      await sendProjections(io, room.id, result.state, setup);
      io.to(roomChannel(room.id)).emit('game:end', { roomCode: room.code, status: 'ENDED', runPhase: 'RESULTS' });
    }
    return result;
  },
};
