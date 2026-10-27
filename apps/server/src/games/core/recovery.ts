import { resolveCanonicalSlug } from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { ENGINE_VERSIONS } from './config.js';
import { checkGameInvariants } from './invariants.js';
import { assertCommandMutation } from './commandExecution.js';
import { CoreRuleError } from './runtimePrimitives.js';

/** Freeze unsafe state without replaying gameplay or discarding the original. */
export async function ensureGameStateSafe(roomId: string): Promise<void> {
  const room = await prisma.room.findUnique({ where: { id: roomId }, include: { gameDefinition: true, gameState: true } });
  if (!room || room.status !== 'RUNNING' || !room.gameState) return;
  const slug = resolveCanonicalSlug(room.gameDefinition.slug) ?? room.gameDefinition.slug;
  const versions = ENGINE_VERSIONS[slug];
  if (!versions) return;
  const row = room.gameState;
  // An unknown version must be read only by its own compatible engine.
  // Do not rewrite its state into the current format.
  if (!versions.supported.includes(row.engineVersion)) throw new CoreRuleError('UNSUPPORTED_ENGINE_VERSION');
  if (row.phase === 'ERROR_RECOVERY') return;
  let state: unknown, issues: string[];
  try { state = JSON.parse(row.stateJson); issues = checkGameInvariants(slug, state, row.phase); }
  catch { issues = ['STATE_JSON']; }
  if (!issues.length) return;
  await prisma.$transaction(async tx => {
    await assertCommandMutation(tx, roomId);
    const frozen = await tx.roomGameState.updateMany({ where: { roomId, revision: row.revision }, data: {
      phase: 'ERROR_RECOVERY', revision: { increment: 1 },
      stateJson: JSON.stringify({ ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}),
        phase: 'ERROR_RECOVERY', recoveryError: 'STATE_INVARIANT_FAILED',
        // Server-only evidence. Projections must never serialize this object.
        recoverySnapshotJson: row.stateJson, recoveryIssues: issues, recoveryBaseStateVersion: row.revision }),
    } });
    if (!frozen.count) throw new CoreRuleError('STATE_CONFLICT');
    const updated = await tx.room.updateMany({ where: { id: roomId, revision: room.revision, status: 'RUNNING' },
      data: { runPhase: 'ERROR_RECOVERY', revision: { increment: 1 } } });
    if (!updated.count) throw new CoreRuleError('STATE_CONFLICT');
    await tx.roomFeedEntry.create({ data: { roomId, kind: 'ERROR', message: 'Spielzustand muss geprüft werden. Das Spiel wurde angehalten.' } });
  });
  logger.error('Game state frozen after invariant failure', { roomId, gameSlug: slug, issues });
  throw new CoreRuleError('STATE_INVARIANT_FAILED');
}

/** Run before restoring timers or accepting connections after a process restart. */
export async function validateActiveGames(): Promise<void> {
  const rooms = await prisma.room.findMany({ where: { status: 'RUNNING' }, select: { id: true } });
  for (const room of rooms) {
    try { await ensureGameStateSafe(room.id); }
    catch (error) {
      if (!(error instanceof CoreRuleError) || !['STATE_INVARIANT_FAILED', 'UNSUPPORTED_ENGINE_VERSION', 'STATE_CONFLICT'].includes(error.code)) throw error;
      logger.warn('Active game requires recovery', { roomId: room.id, code: error.code });
    }
  }
}
