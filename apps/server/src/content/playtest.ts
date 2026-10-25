import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { validateContentPayload, type ContentPlaytestView } from '@quiz/shared';
import { ContentError, contentActor, requirePool, auditContent, type ContentDb, type ContentActor } from './core.js';
import { requireContributor } from './operations.js';
import { contentMediaUrl } from './media.js';
import { previewContentPayload } from './preview.js';
import { hasPlaytestAuthority } from './playtestAccess.js';
import { prisma } from '../persistence/prisma.js';

export const CreatePlaytestSchema = z.object({ commandId: z.string().uuid(), poolId: z.string().min(1).max(128),
  items: z.array(z.object({ id: z.string().min(1).max(128), revision: z.number().int().positive() }).strict()).min(1).max(20) }).strict();
export const PlaytestReadSchema = z.object({ role: z.enum(['HOST', 'PLAYER', 'VIEWER', 'TEAM']).default('PLAYER'), clientKey: z.string().uuid().optional() }).strict();
const snapshotsSchema = z.array(z.object({ id: z.string(), revision: z.number().int().positive(), payload: z.record(z.unknown()) }));
export async function createContentPlaytest(db: ContentDb, actor: ContentActor, input: z.infer<typeof CreatePlaytestSchema>) {
  const pool = await requirePool(db, input.poolId, actor); requireContributor(pool, actor);
  if (new Set(input.items.map(i => i.id)).size !== input.items.length) throw new ContentError('INVALID_CONTENT_SELECTION');
  if (await db.contentPlaytest.count({ where: { ownerId: actor.userId, expiresAt: { gt: new Date() }, phase: { not: 'CLOSED' } } }) >= 20) throw new ContentError('PLAYTEST_LIMIT', 409);
  const snapshots = [];
  for (const ref of input.items) {
    const item = await db.contentItem.findFirst({ where: { id: ref.id, poolId: pool.id, status: { not: 'TRASHED' } } });
    if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
    if (item.revision !== ref.revision) throw new ContentError('REVISION_CONFLICT', 409);
    const raw = JSON.parse(item.payloadJson), validation = validateContentPayload(pool.gameSlug, raw);
    snapshots.push({ id: item.id, revision: item.revision, payload: validation.success ? validation.data : raw });
  }
  const row = await db.contentPlaytest.create({ data: { code: randomBytes(16).toString('base64url'), ownerId: actor.userId, poolId: pool.id,
    gameSlug: pool.gameSlug, snapshotJson: JSON.stringify(snapshots), expiresAt: new Date(Date.now() + 3600000) } });
  await auditContent(db, actor, 'CONTENT_PLAYTEST_CREATE', row.id, { count: snapshots.length, expiresAt: row.expiresAt });
  return { code: row.code, poolId: pool.id, expiresAt: row.expiresAt.toISOString() };
}
async function testRow(db: ContentDb, code: string) {
  const row = await db.contentPlaytest.findUnique({ where: { code } });
  if (!row || row.expiresAt <= new Date() || !await hasPlaytestAuthority(db, row)) throw new ContentError('PLAYTEST_NOT_ACCESSIBLE', 404); return row;
}
export async function readContentPlaytest(db: ContentDb, code: string, sessionId: string | null, input: z.infer<typeof PlaytestReadSchema>): Promise<ContentPlaytestView> {
  const row = await testRow(db, code); let actor: ContentActor | null = null;
  try { actor = await contentActor(db, sessionId); } catch { /* Shared capability permits guest preview, never HOST secrets. */ }
  const owner = actor?.userId === row.ownerId;
  if (row.phase === 'CLOSED' && !owner) throw new ContentError('PLAYTEST_NOT_ACCESSIBLE', 404);
  if (input.role === 'HOST' && !owner) throw new ContentError('NOT_AUTHORIZED', 403);
  const snapshots = snapshotsSchema.parse(JSON.parse(row.snapshotJson)), current = snapshots[row.position];
  const validation = validateContentPayload(row.gameSlug, current.payload);
  const own = input.clientKey ? await db.contentPlaytestFeedback.findMany({ where: { playtestId: row.id, position: row.position, clientKey: input.clientKey } }) : [];
  const hasMedia = typeof current.payload.mediaAssetId === 'string' && await db.contentMediaReference.count({ where: { itemId: current.id, itemRevision: current.revision, assetId: current.payload.mediaAssetId } });
  const media = hasMedia ? { mediaType: typeof current.payload.mediaType === 'string' ? current.payload.mediaType : undefined,
    mediaUrl: contentMediaUrl(String(current.payload.mediaAssetId), { kind: 'PLAYTEST', code: row.code, itemId: current.id, revision: current.revision }) } : {};
  const duration = current.payload.durationMs, endsAt = row.gameSlug === 'wissensduell' && typeof duration === 'number' && duration >= 1000 && duration <= 3600000 ? row.startedAt.getTime() + duration : null;
  return { code: row.code, gameSlug: row.gameSlug, phase: row.phase as 'QUESTION' | 'REVEAL' | 'CLOSED', version: row.version, position: row.position, total: snapshots.length,
    role: input.role, canControl: owner, expiresAt: row.expiresAt.toISOString(), endsAt,
    question: row.phase === 'CLOSED' ? null : { ...previewContentPayload(row.gameSlug, current.payload, row.phase === 'REVEAL' || input.role === 'HOST'), ...media },
    warnings: validation.success ? [] : validation.error.issues.map(e => ({ path: e.path.join('.'), message: owner && input.role === 'HOST' ? e.message : 'Dieses Feld im Entwurf prüfen.' })),
    ownAnswer: own.find(r => r.kind === 'ANSWER')?.value ?? null, ownReport: own.some(r => r.kind === 'REPORT'),
    reports: owner && input.role === 'HOST' ? (await db.contentPlaytestFeedback.findMany({ where: { playtestId: row.id, kind: 'REPORT' }, orderBy: { createdAt: 'asc' } })).map(r => ({ position: r.position, message: r.value, createdAt: r.createdAt.toISOString() })) : [],
  };
}
export async function controlContentPlaytest(db: ContentDb, actor: ContentActor, code: string, version: number, action: 'REVEAL' | 'NEXT' | 'CLOSE') {
  const row = await testRow(db, code);
  if (row.ownerId !== actor.userId) throw new ContentError('NOT_AUTHORIZED', 403);
  if (row.version !== version) throw new ContentError('REVISION_CONFLICT', 409);
  if (row.phase === 'CLOSED') throw new ContentError('PLAYTEST_CLOSED', 409);
  if (action === 'REVEAL' && row.phase !== 'QUESTION') throw new ContentError('INVALID_PLAYTEST_TRANSITION', 409);
  const next = row.position + 1, snapshots = snapshotsSchema.parse(JSON.parse(row.snapshotJson));
  if (action === 'NEXT' && next >= snapshots.length) throw new ContentError('PLAYTEST_END', 409);
  await db.contentPlaytest.update({ where: { id: row.id, version }, data: { version: { increment: 1 }, phase: action === 'CLOSE' ? 'CLOSED' : action === 'REVEAL' ? 'REVEAL' : 'QUESTION',
    ...(action === 'NEXT' ? { position: next, startedAt: new Date() } : {}) } });
  await auditContent(db, actor, 'CONTENT_PLAYTEST_CONTROL', row.id, { action, version: version + 1 }); return { code: row.code, version: version + 1 };
}
export const PlaytestFeedbackSchema = z.object({ clientKey: z.string().uuid(), version: z.number().int().positive(), role: z.enum(['HOST', 'PLAYER', 'VIEWER', 'TEAM']),
  kind: z.enum(['ANSWER', 'REPORT']), value: z.string().trim().min(1).max(10000) }).strict();
export async function submitPlaytestFeedback(code: string, sessionId: string | null, input: z.infer<typeof PlaytestFeedbackSchema>) {
  return prisma.$transaction(async db => {
    await db.$executeRaw`UPDATE content_playtests SET id=id WHERE 0`;
    const row = await testRow(db, code), view = await readContentPlaytest(db, code, sessionId, { role: input.role, clientKey: input.clientKey });
    if (row.phase === 'CLOSED') throw new ContentError('PLAYTEST_CLOSED', 409);
    if (input.role !== 'PLAYER' && !(input.role === 'HOST' && view.canControl && input.kind === 'REPORT')) throw new ContentError('NOT_AUTHORIZED', 403);
    if (row.version !== input.version) throw new ContentError('REVISION_CONFLICT', 409);
    const key = { playtestId: row.id, position: row.position, clientKey: input.clientKey, kind: input.kind };
    const prior = await db.contentPlaytestFeedback.findUnique({ where: { playtestId_position_clientKey_kind: key } });
    if (prior) { if (prior.value !== input.value) throw new ContentError('SUBMISSION_CONFLICT', 409); return { accepted: true }; }
    if (await db.contentPlaytestFeedback.count({ where: { playtestId: row.id } }) >= 200) throw new ContentError('PLAYTEST_FEEDBACK_LIMIT', 409);
    if (input.kind === 'REPORT' && input.value.length > 2000) throw new ContentError('INVALID_CONTENT');
    if (input.kind === 'ANSWER') {
      if (row.phase !== 'QUESTION' || view.endsAt !== null && view.endsAt <= Date.now()) throw new ContentError('PLAYTEST_ANSWER_CLOSED', 409);
      if (row.gameSlug === 'wissensduell' && !(view.question?.options as Array<{ id: string }> ?? []).some(o => o.id === input.value)) throw new ContentError('INVALID_OPTION');
    }
    await db.contentPlaytestFeedback.create({ data: { ...key, value: input.value } }); return { accepted: true };
  });
}
