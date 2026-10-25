import { createHash } from 'node:crypto';
import type { ContentItem, ContentPool, Prisma } from '@prisma/client';
import { ContentDefaultsSchema, ContentItemInputSchema, ContentSelectionSchema, validateContentPayload,
  type ContentItemView, type ContentPoolView } from '@quiz/shared';
import { prisma } from '../persistence/prisma.js';
import { validateContentMedia, recordContentMediaReference } from './media.js';
import { shuffleServer } from '../games/core/roundFlow.js';

export class ContentError extends Error {
  constructor(public code: string, public status = 400, public details?: unknown) { super(code); }
}
export interface ContentActor { sessionId: string; userId: string; role: string }
export type ContentDb = Prisma.TransactionClient;
export async function contentActor(db: ContentDb, sessionId: string | null): Promise<ContentActor> {
  if (!sessionId) throw new ContentError('NOT_AUTHENTICATED', 401);
  const session = await db.session.findFirst({ where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } }, include: { user: true } });
  if (!session || !['HOST', 'ADMIN'].includes(session.user.role)) throw new ContentError('NOT_AUTHENTICATED', 401);
  return { sessionId, userId: session.userId, role: session.user.role };
}
function editors(pool: ContentPool): string[] { return JSON.parse(pool.editorIdsJson); }
export function canReadPool(pool: ContentPool, actor: ContentActor): boolean {
  return actor.role === 'ADMIN' || pool.ownerId === actor.userId || ['PUBLIC', 'SYSTEM'].includes(pool.scope)
    || (pool.scope === 'SHARED' && editors(pool).includes(actor.userId));
}
export function canContributePool(pool: ContentPool, actor: ContentActor): boolean {
  return actor.role === 'ADMIN' || pool.ownerId === actor.userId || (pool.scope === 'SHARED' && editors(pool).includes(actor.userId));
}
export function canEditPool(pool: ContentPool, actor: ContentActor): boolean {
  return actor.role === 'ADMIN' || (!['PUBLIC', 'SYSTEM'].includes(pool.scope)
    && (pool.ownerId === actor.userId || (pool.scope === 'SHARED' && editors(pool).includes(actor.userId))));
}
export async function requirePool(db: ContentDb, id: string, actor: ContentActor, edit = false) {
  const pool = await db.contentPool.findUnique({ where: { id } });
  if (!pool || !canReadPool(pool, actor)) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  if (edit && (!canEditPool(pool, actor) || pool.status !== 'ACTIVE')) throw new ContentError('NOT_AUTHORIZED', 403);
  return pool;
}
export function poolView(pool: ContentPool, actor: ContentActor): ContentPoolView {
  return { id: pool.id, name: pool.name, description: pool.description, gameSlug: pool.gameSlug, ownerId: pool.ownerId,
    scope: pool.scope, revision: pool.revision, defaults: ContentDefaultsSchema.parse(JSON.parse(pool.defaultsJson)), canEdit: canEditPool(pool, actor) && pool.status === 'ACTIVE',
    canReadInternal: canContributePool(pool, actor), canAssignReview: actor.role === 'ADMIN' || pool.ownerId === actor.userId,
    canPropose: pool.status === 'ACTIVE' && (pool.ownerId === actor.userId || actor.role === 'ADMIN'),
    canManage: pool.status === 'ACTIVE' && canEditPool(pool, actor) && (pool.ownerId === actor.userId || actor.role === 'ADMIN'), editorIds: editors(pool) };
}
export function itemView(item: ContentItem, pool: ContentPool): ContentItemView {
  const defaults = ContentDefaultsSchema.parse(JSON.parse(pool.defaultsJson));
  const rawPayload: Record<string, unknown> = JSON.parse(item.payloadJson);
  const validation = validateContentPayload(item.gameSlug, rawPayload);
  // Display the same effective game defaults that selection/engines use.
  // Invalid drafts preserve their original input for correction.
  const payload: Record<string, unknown> = validation.success ? validation.data : rawPayload;
  const tagIds: string[] | null = item.tagIdsJson === null ? null : JSON.parse(item.tagIdsJson);
  return { id: item.id, poolId: item.poolId, gameSlug: item.gameSlug, revision: item.revision, status: item.status, title: item.title,
    payload, language: item.language, difficulty: item.difficulty, tagIds, source: item.source, sourceUrl: item.sourceUrl, license: item.license,
    reviewState: item.reviewState, lockState: item.lockState, updatedAt: item.updatedAt.toISOString(),
    effective: { language: item.language ?? defaults.language, difficulty: item.difficulty ?? defaults.difficulty, tagIds: tagIds ?? defaults.tagIds },
    validation: validation.success ? [] : validation.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) };
}
export async function validateTagIds(db: ContentDb, ids: string[]) {
  if (new Set(ids).size !== ids.length || await db.contentTag.count({ where: { id: { in: ids } } }) !== ids.length)
    throw new ContentError('INVALID_TAG_REFERENCE');
}
export async function auditContent(db: ContentDb, actor: ContentActor, action: string, id: string, details: unknown) {
  await db.auditLog.create({ data: { userId: actor.userId, action, resource: 'CONTENT', resourceId: id, metadata: JSON.stringify(details) } });
}
export async function saveRevision(db: ContentDb, item: ContentItem, actor: ContentActor, kind: string, changedFields: string[]) {
  await db.contentRevision.create({ data: { itemId: item.id, revision: item.revision, actorId: actor.userId, kind,
    changedFieldsJson: JSON.stringify(changedFields), snapshotJson: JSON.stringify(item) } });
  await recordContentMediaReference(db, actor, item);
  await auditContent(db, actor, `CONTENT_${kind}`, item.id, { revision: item.revision, changedFields });
}
export function contentInputData(input: unknown) {
  const value = ContentItemInputSchema.parse(input);
  return { title: value.title, payloadJson: JSON.stringify(value.payload), language: value.language, difficulty: value.difficulty,
    tagIdsJson: value.tagIds === null ? null : JSON.stringify(value.tagIds), source: value.source, sourceUrl: value.sourceUrl, license: value.license };
}
/** Receipt, session fence, revision checks and writes all share one transaction. */
export async function mutateContent<T>(sessionId: string | null, commandId: string, intent: unknown, write: (tx: ContentDb, actor: ContentActor) => Promise<T>): Promise<T> {
  const intentHash = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  return prisma.$transaction(async tx => {
    // Reserve the SQLite writer before the authorization read set. Two
    // concurrent editors must serialize at the DB, then compare revisions;
    // upgrading competing read transactions can otherwise deadlock.
    await tx.$executeRaw`UPDATE sessions SET id = id WHERE 0`;
    const actor = await contentActor(tx, sessionId);
    // SQLite obtains the writer reservation before any authorization/read set.
    const lock = await tx.session.updateMany({ where: { id: actor.sessionId, revokedAt: null, expiresAt: { gt: new Date() } }, data: { lastActiveAt: new Date() } });
    if (!lock.count) throw new ContentError('NOT_AUTHENTICATED', 401);
    const receipt = await tx.contentMutationReceipt.findUnique({ where: { actorId_commandId: { actorId: actor.userId, commandId } } });
    if (receipt) {
      if (receipt.intentHash !== intentHash) throw new ContentError('COMMAND_CONFLICT', 409);
      const result = JSON.parse(receipt.responseJson);
      if (result?.poolId) await requirePool(tx, String(result.poolId), actor);
      else if (result?.gameSlug && result?.id) await requirePool(tx, String(result.id), actor);
      // Compound results (review/batch) may contain items from other pools.
      // Re-check those grants as well before replaying a stored response.
      for (const item of [result?.payload ? result : null, result?.item, ...(Array.isArray(result?.results) ? result.results.map((r: { item?: { poolId?: string } }) => r.item) : [])]) {
        if (item?.poolId) {
          const pool = await requirePool(tx, String(item.poolId), actor);
          if (['PUBLIC', 'SYSTEM'].includes(pool.scope) && !canContributePool(pool, actor)) {
            const current = await tx.contentItem.findUnique({ where: { id: String(item.id) } });
            if (!current || current.revision !== item.revision || current.status !== 'READY' || current.reviewState !== 'APPROVED') throw new ContentError('NOT_AUTHORIZED', 403);
          }
        }
      }
      if (result?.itemId) {
        const item = await tx.contentItem.findUnique({ where: { id: String(result.itemId) } });
        if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
        const pool = await requirePool(tx, item.poolId, actor);
        if (!canContributePool(pool, actor)) throw new ContentError('NOT_AUTHORIZED', 403);
        if (result.assigneeId && actor.role !== 'ADMIN' && result.assigneeId !== actor.userId && result.assignedBy !== actor.userId && pool.ownerId !== actor.userId) throw new ContentError('NOT_AUTHORIZED', 403);
      }
      if (result?.reviewId) {
        const review = await tx.contentReview.findUnique({ where: { id: String(result.reviewId) } });
        if (!review || !canContributePool(await requirePool(tx, review.poolId, actor), actor)) throw new ContentError('NOT_AUTHORIZED', 403);
      }
      return result as T;
    }
    const result = await write(tx, actor);
    await tx.contentMutationReceipt.create({ data: { actorId: actor.userId, commandId, intentHash, responseJson: JSON.stringify(result) } });
    return result;
  }, { timeout: 15000 });
}
export async function changeItem(db: ContentDb, actor: ContentActor, id: string, revision: number, input: unknown, restore = false) {
  const item = await db.contentItem.findUnique({ where: { id } });
  if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const pool = await requirePool(db, item.poolId, actor, true);
  if (item.revision !== revision) throw new ContentError('REVISION_CONFLICT', 409, { currentRevision: item.revision });
  if (item.lockState !== 'EDITABLE') throw new ContentError('CONTENT_LOCKED', 409);
  const value = ContentItemInputSchema.parse(input); await validateTagIds(db, value.tagIds ?? []);
  await validateContentMedia(db, actor, value.payload);
  const data = contentInputData(value);
  const fields = Object.entries(data).filter(([k, v]) => item[k as keyof ContentItem] !== v).map(([k]) => k);
  if (!fields.length && !restore) return itemView(item, pool);
  // Editing never silently publishes: READY becomes DRAFT until explicitly validated.
  const updated = await db.contentItem.update({ where: { id, revision }, data: { ...data, status: 'DRAFT', reviewState: 'NOT_REVIEWED', revision: { increment: 1 } } });
  await saveRevision(db, updated, actor, restore ? 'RESTORE' : 'EDIT', fields);
  return itemView(updated, pool);
}

export interface PinnedContent { id: string; poolId: string; poolRevision: number; revision: number; gameSlug: string; payload: Record<string, unknown>; language: string; difficulty: string | null; tagIds: string[] }
/** Called inside room creation; the browser supplies only selection intent, never trusted snapshots. */
export async function selectRoomContent(db: ContentDb, actor: ContentActor, gameSlug: string, raw: unknown, roomId?: string): Promise<PinnedContent[]> {
  const selection = ContentSelectionSchema.parse(raw);
  if (new Set(selection.poolIds).size !== selection.poolIds.length) throw new ContentError('DUPLICATE_POOL');
  const pools = await Promise.all(selection.poolIds.map(id => requirePool(db, id, actor)));
  if (pools.some(p => p.gameSlug !== gameSlug || p.status !== 'ACTIVE')) throw new ContentError('CONTENT_GAME_MISMATCH');
  const rows = await db.contentItem.findMany({ where: { poolId: { in: selection.poolIds }, status: 'READY' }, orderBy: { id: 'asc' } });
  let items = rows.map(row => {
    const view = itemView(row, pools.find(p => p.id === row.poolId)!);
    return { id: row.id, poolId: row.poolId, poolRevision: pools.find(p => p.id === row.poolId)!.revision, revision: row.revision, gameSlug, payload: view.payload, ...view.effective };
  }).filter(q => q.language === selection.language && (!selection.difficulty || q.difficulty === selection.difficulty) && selection.tagIds.every(id => q.tagIds.includes(id))
    && (!selection.category || String(q.payload.category).trim().toLocaleLowerCase() === selection.category.toLocaleLowerCase()));
  const prior = roomId ? new Set((await db.contentUse.findMany({ where: { roomId }, select: { itemId: true } })).map(q => q.itemId)) : new Set<string>();
  let expectedCount = selection.count;
  if (selection.mode === 'MANUAL') {
    if (selection.poolCounts) throw new ContentError('INVALID_CONTENT_SELECTION');
    if (!selection.itemIds.length || new Set(selection.itemIds).size !== selection.itemIds.length) throw new ContentError('INVALID_CONTENT_SELECTION');
    items = selection.itemIds.map(id => { const found = items.find(q => q.id === id); if (!found || selection.repeatRule === 'NO_REPEAT_IN_ROOM' && prior.has(id)) throw new ContentError('CONTENT_NOT_READY'); return found; });
  } else {
    if (selection.repeatRule === 'NO_REPEAT_IN_ROOM') items = items.filter(q => !prior.has(q.id));
    const pick = (candidates: PinnedContent[], count: number) => {
      if (candidates.length < count) throw new ContentError('CONTENT_NOT_READY');
      return selection.repeatRule === 'PREFER_UNSEEN'
        ? [...shuffleServer(candidates.filter(q => !prior.has(q.id))), ...shuffleServer(candidates.filter(q => prior.has(q.id)))].slice(0, count)
        : shuffleServer(candidates).slice(0, count);
    };
    if (selection.poolCounts) {
      const counts = selection.poolCounts;
      if (Object.keys(counts).length !== selection.poolIds.length || !selection.poolIds.every(id => Object.hasOwn(counts, id))) throw new ContentError('INVALID_CONTENT_SELECTION');
      expectedCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
      if (expectedCount < 1 || expectedCount > 100) throw new ContentError('INVALID_CONTENT_SELECTION');
      items = selection.poolIds.flatMap(id => pick(items.filter(q => q.poolId === id), counts[id]));
    } else items = pick(items, selection.count);
  }
  if (!items.length || (selection.mode === 'RANDOM' && items.length < expectedCount)) throw new ContentError('CONTENT_NOT_READY');
  for (const q of items) {
    const valid = validateContentPayload(gameSlug, q.payload);
    if (!valid.success) throw new ContentError('CONTENT_NOT_READY');
    await validateContentMedia(db, actor, valid.data, true, ['PUBLIC', 'SYSTEM'].includes(pools.find(p => p.id === q.poolId)!.scope));
    q.payload = valid.data;
  }
  return items;
}
export function applyPinnedContent(setup: Record<string, unknown>, gameSlug: string, items: PinnedContent[]) {
  if (gameSlug === 'wissensduell') return { ...setup, selectedQuestionIds: items.map(q => q.id), questionCount: items.length };
  if (gameSlug === 'jeopardy') {
    const categories = new Map<string, Array<Record<string, unknown>>>();
    for (const q of items) { const name = String(q.payload.category); categories.set(name, [...(categories.get(name) ?? []), { ...q.payload, contentId: q.id, contentRevision: q.revision }]); }
    if (categories.size > 6 || [...categories.values()].some(clues => new Set(clues.map(c => c.value)).size !== clues.length)) throw new ContentError('INVALID_JEOPARDY_BOARD');
    const rest = { ...setup }; delete rest.board2;
    return { ...rest, board1: { categories: [...categories].map(([name, clues]) => ({ name, clues: clues.sort((a, b) => Number(a.value) - Number(b.value)) })) } };
  }
  throw new ContentError('CONTENT_GAME_UNSUPPORTED');
}
/** Internal-only persisted payloads; never derived from untrusted room setup. */
export async function readPinnedContent(roomId: string, db: ContentDb = prisma) {
  const room = await db.room.findUniqueOrThrow({ where: { id: roomId } });
  const rows = await db.contentUse.findMany({ where: { roomId, runIndex: room.runIndex }, orderBy: { position: 'asc' } });
  return rows.map(row => JSON.parse(row.snapshotJson) as PinnedContent);
}
