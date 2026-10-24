import { z } from 'zod';
import type { Server, Socket } from 'socket.io';
import type { Prisma } from '@prisma/client';
import { applyStateEvent, type GameEngineContract, type EngineCommand, type EngineValidation } from '@quiz/game-sdk';
import { getGameManifest, resolveCanonicalSlug } from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import { roomPreflight } from '../../rooms/core.js';
import { pauseUntimedGame } from '../../rooms/pause.js';
import { handleGeoGame } from '../geo/index.js';
import { projectGeoStateForClient, type GeoState } from '../geo/resync.js';
import { handleJeopardyGame } from '../jeopardy/engine.js';
import { projectJeopardyForClient } from '../jeopardy/projection.js';
import type { JeopardyGameState } from '../jeopardy/state.js';
import { werIstDasGame } from '../weristdas/engine.js';
import { projectWerIstDas } from '../weristdas/resync.js';
import { WerIstDasSetupSchema, WerIstDasRoundSchema } from '../weristdas/contracts.js';
import type { WerIstDasState } from '../weristdas/state.js';
import { ENGINE_VERSIONS } from './config.js';
import { authorizeGameContext, type GameActor } from './access.js';
import { coreActionDenial, type CoreActionContext } from './actionRules.js';
import { checkGameInvariants } from './invariants.js';
import { CoreRuleError } from './runtimePrimitives.js';
import { WissensduellSetupSchema, WissensduellContentSchema, JeopardySetupSchema, JeopardyContentSchema } from './setupSchemas.js';
import { buildEngineRoundResult, buildEngineGameResult, type EngineResultContext } from './resultBuilders.js';

interface InitializeContext { io: Server; room: { id: string; code: string; setupSnapshotJson: string | null }; initialPhase: string }
interface CommandContext { io: Server; socket: Socket }
interface ProjectionContext { state: unknown; setup: unknown; actor: GameActor; participants: ReadonlyArray<{ id: string; displayName: string }>; stateVersion?: number }
interface ContractTypes {
  State: unknown; Setup: unknown; InitializeContext: InitializeContext;
  PreflightContext: { roomId: string; overrideReady?: boolean; db?: Prisma.TransactionClient };
  CommandContext: CommandContext; CommandValidationContext: CoreActionContext; ProjectionContext: ProjectionContext; ResultContext: EngineResultContext;
}
export type ServerGameEngineContract = GameEngineContract<ContractTypes>;
type Result = { success: boolean; error?: string; [key: string]: unknown };
const emptyPayload = z.object({}).passthrough();
const roomPayload = z.object({ roomCode: z.string().regex(/^\d{3}-\d{3}$/) }).passthrough();
function commandSchema(slug: string, action: string): z.ZodType<unknown> | null {
  if (['pause', 'resume', 'end'].includes(action)) return roomPayload;
  if (slug === 'wissensduell') return action === 'answer' ? z.object({ optionId: z.string().min(1).max(10000) }).passthrough()
    : ['joker5050', 'jokerSpy', 'jokerRisk', 'reveal', 'next'].includes(action) ? roomPayload : null;
  if (slug === 'jeopardy') {
    if (action === 'fieldOpen') return z.object({ boardIndex: z.union([z.literal(1), z.literal(2)]), categoryIndex: z.number().int().min(0).max(5), value: z.number().int().positive() }).passthrough();
    if (['judge', 'stealJudge'].includes(action)) return z.object({ correct: z.boolean() }).passthrough();
    if (action === 'boardSwitch') return z.object({ toBoard: z.union([z.literal(1), z.literal(2)]) }).passthrough();
    return ['buzz', 'stealBuzz', 'next'].includes(action) ? emptyPayload : null;
  }
  if (slug === 'wer-ist-das') return action === 'judge' ? z.object({ result: z.enum(['BOTH_CORRECT', 'ONE_CORRECT', 'WRONG']) }).passthrough()
    : ['open', 'buzz', 'hint', 'reveal', 'next'].includes(action) ? emptyPayload : null;
  return null;
}
function callbackResult(run: (done: (result: Result) => void) => Promise<unknown>): Promise<Result> {
  return new Promise((resolve, reject) => { void run(resolve).catch(reject); });
}
async function dispatch(slug: string, context: CommandContext, command: EngineCommand): Promise<Result> {
  const schema = commandSchema(slug, command.action), parsed = schema?.safeParse(command.payload);
  if (!schema) return { success: false, error: 'COMMAND_UNSUPPORTED' };
  if (!parsed?.success) return { success: false, error: 'INVALID_PAYLOAD' };
  const payload = parsed.data as Record<string, unknown>, { io, socket } = context;
  const action = command.action;
  if (action === 'pause' || action === 'resume') return callbackResult(done => slug === 'wissensduell'
    ? (action === 'pause' ? handleGeoGame.handlePause(io, socket, { roomCode: String(payload.roomCode) }, done) : handleGeoGame.handleResume(io, socket, { roomCode: String(payload.roomCode) }, done))
    : pauseUntimedGame({ io, socket, roomCode: String(payload.roomCode), callback: done }, action === 'pause'));
  if (action === 'end' || action === 'boardSwitch') {
    const auth = await authorizeGameContext(socket, { gameSlug: slug, roles: ['HOST'], requireParticipation: true,
      controlPermission: action === 'end' ? 'GAME_ABORT' : 'ROUND_ADVANCE' });
    if (!auth.ok) return { success: false, error: auth.error };
    if (payload.roomCode && payload.roomCode !== auth.room.code) return { success: false, error: 'WRONG_ROOM' };
    if (action === 'boardSwitch') {
      const row = await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: auth.room.id } });
      if (payload.toBoard !== (JSON.parse(row.stateJson).currentBoard === 1 ? 2 : 1)) return { success: false, error: 'WRONG_BOARD' };
      return handleJeopardyGame.handleBoardSwitch(io, auth.room);
    }
    if (slug === 'wissensduell') { await handleGeoGame.end(io, auth.room); return { success: true }; }
    if (slug === 'jeopardy') return handleJeopardyGame.handleGameEnd(io, auth.room, undefined, true);
    await werIstDasGame.end(io, auth.room); return { success: true };
  }
  if (slug === 'wissensduell') {
    const roomData = { roomCode: String(payload.roomCode) };
    if (action === 'answer') return callbackResult(done => handleGeoGame.handleAnswer(io, socket, { optionId: String(payload.optionId),
      ...(typeof payload.questionIndex === 'number' ? { questionIndex: payload.questionIndex } : {}) }, done));
    if (action === 'joker5050') return callbackResult(done => handleGeoGame.handleJoker5050(io, socket, roomData, done));
    if (action === 'jokerSpy') return callbackResult(done => handleGeoGame.handleJokerSpy(io, socket, roomData, done));
    if (action === 'jokerRisk') return callbackResult(done => handleGeoGame.handleJokerRisk(io, socket, roomData, done));
    if (action === 'reveal') return callbackResult(done => handleGeoGame.handleReveal(io, socket, roomData, done));
    if (action === 'next') return callbackResult(done => handleGeoGame.handleNext(io, socket, roomData, done));
  }
  if (slug === 'jeopardy') {
    if (action === 'fieldOpen') return handleJeopardyGame.handleFieldOpen(io, socket, payload as { boardIndex: 1 | 2; categoryIndex: number; value: number });
    if (action === 'buzz') return handleJeopardyGame.handleBuzz(io, socket);
    if (action === 'judge') return handleJeopardyGame.handleJudge(io, socket, payload as { correct: boolean });
    if (action === 'stealBuzz') return handleJeopardyGame.handleStealBuzz(io, socket);
    if (action === 'stealJudge') return handleJeopardyGame.handleStealJudge(io, socket, payload as { correct: boolean });
    if (action === 'next') return handleJeopardyGame.handleNext(io, socket);
  }
  if (slug === 'wer-ist-das') return werIstDasGame.act(io, socket, action as 'open' | 'buzz' | 'hint' | 'judge' | 'reveal' | 'next',
    action === 'judge' ? payload as { result: 'BOTH_CORRECT' | 'ONE_CORRECT' | 'WRONG' } : undefined);
  return { success: false, error: 'COMMAND_UNSUPPORTED' };
}
const cache = new Map<string, ServerGameEngineContract>();
/** Lazily resolve real engines, avoiding module-initialization cycles between old adapters. */
export function getGameEngineContract(inputSlug: string): ServerGameEngineContract | null {
  const slug = resolveCanonicalSlug(inputSlug) ?? inputSlug;
  if (!['wissensduell', 'jeopardy', 'wer-ist-das'].includes(slug)) return null;
  const existing = cache.get(slug); if (existing) return existing;
  const manifest = getGameManifest(slug); if (!manifest) throw new Error('MANIFEST_MISSING');
  const setupSchema = slug === 'wissensduell' ? WissensduellSetupSchema : slug === 'jeopardy' ? JeopardySetupSchema : WerIstDasSetupSchema;
  const contentSchema = slug === 'wissensduell' ? WissensduellContentSchema : slug === 'jeopardy' ? JeopardyContentSchema : WerIstDasRoundSchema;
  const validVersion = (engineVersion: number, gameSlug: string) => {
    if (resolveCanonicalSlug(gameSlug) !== slug) throw new CoreRuleError('WRONG_GAME');
    if (!ENGINE_VERSIONS[slug].supported.includes(engineVersion)) throw new CoreRuleError('UNSUPPORTED_ENGINE_VERSION');
  };
  const contract: ServerGameEngineContract = {
    manifest, setupSchema, contentSchema,
    validateSetup: input => setupSchema.safeParse(input).success ? { success: true } : { success: false, error: 'INVALID_SETUP' },
    async createInitialState(context) {
      const setup: unknown = JSON.parse(context.room.setupSnapshotJson ?? '{}');
      if (!contract.validateSetup(setup).success) throw new Error('INVALID_SETUP');
      if (slug === 'wissensduell') await handleGeoGame.initialize(context.io, context.room, context.initialPhase);
      else if (slug === 'jeopardy') await handleJeopardyGame.initialize(context.io, context.room);
      else await werIstDasGame.initialize(context.io, context.room);
      const row = await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: context.room.id } });
      return JSON.parse(row.stateJson) as unknown;
    },
    async preflightCheck(context) {
      const db = context.db ?? prisma;
      const result = await roomPreflight(context.roomId, context.overrideReady, db);
      const room = await db.room.findUniqueOrThrow({ where: { id: context.roomId } });
      let setup: unknown;
      try { setup = JSON.parse(room.setupSnapshotJson ?? '{}'); } catch { setup = null; }
      if (!contract.validateSetup(setup).success && !result.blockers.includes('INVALID_SETUP')) result.blockers.push('INVALID_SETUP');
      return { ...result, status: result.blockers.length ? 'BLOCKED' : result.warnings.length ? 'WARNINGS' : 'READY_TO_START' };
    },
    validateCommand(context, command): EngineValidation {
      const denied = coreActionDenial(context, command.action); if (denied) return { success: false, error: denied };
      const schema = commandSchema(slug, command.action);
      return schema?.safeParse(command.payload).success ? { success: true } : { success: false, error: schema ? 'INVALID_PAYLOAD' : 'COMMAND_UNSUPPORTED' };
    },
    handleCommand: (context, command) => dispatch(slug, context, command),
    applyEvent(snapshot, event) { validVersion(snapshot.engineVersion, snapshot.gameSlug); return applyStateEvent(snapshot, event); },
    createProjection(context) {
      if (slug === 'wissensduell' && z.object({ phase: z.literal('ERROR_RECOVERY'), recoveryError: z.literal('STATE_INVARIANT_FAILED') }).safeParse(context.state).success)
        return { ...projectGeoStateForClient(context.state as GeoState, context.actor), stateVersion: context.stateVersion };
      if (checkGameInvariants(slug, context.state).length) throw new Error('STATE_INVARIANT_FAILED');
      const projected = slug === 'wissensduell' ? projectGeoStateForClient(context.state as GeoState, context.actor)
        : slug === 'jeopardy' ? projectJeopardyForClient(context.state as JeopardyGameState, context.setup, context.actor.role, context.participants)
        : projectWerIstDas(context.state as WerIstDasState, WerIstDasSetupSchema.parse(context.setup), context.actor.role, context.actor.participationId);
      return { ...projected, stateVersion: context.stateVersion };
    },
    buildRoundResult(context) { validVersion(context.engineVersion, context.gameSlug); return buildEngineRoundResult({ ...context, gameSlug: slug }); },
    buildGameResult(context) { validVersion(context.engineVersion, context.gameSlug); return buildEngineGameResult({ ...context, gameSlug: slug }); },
    recovery: { supportedEngineVersions: ENGINE_VERSIONS[slug].supported, resync: 'PERSISTED_STATE', unsafeState: 'PAUSE_AND_NOTIFY_HOST',
      fallbacks: ['RETRY', 'PAUSE_AND_NOTIFY_HOST'] },
  };
  cache.set(slug, contract); return contract;
}
