import type { ContentPool } from '@prisma/client';
import { z } from 'zod';
import { ContentBatchSchema, ContentItemInputSchema, type ContentStatus, validateContentPayload } from '@quiz/shared';
import { ContentError, requirePool, itemView, validateTagIds, saveRevision, changeItem, contentInputData,
  type ContentDb, type ContentActor } from './core.js';

/** Internal editorial data is never exposed to other readers of a PUBLIC pool. */
export function requireContributor(pool: ContentPool, actor: ContentActor) {
  if (actor.role !== 'ADMIN' && pool.ownerId !== actor.userId && !(pool.scope === 'SHARED' &&
    (JSON.parse(pool.editorIdsJson) as string[]).includes(actor.userId))) throw new ContentError('NOT_AUTHORIZED', 403);
}
export async function setItemStatus(db: ContentDb, actor: ContentActor, id: string, revision: number, requested: ContentStatus, preview = false) {
  const item = await db.contentItem.findUnique({ where: { id } }); if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const pool = await requirePool(db, item.poolId, actor, true);
  if (item.revision !== revision) throw new ContentError('REVISION_CONFLICT', 409);
  if (item.lockState !== 'EDITABLE') throw new ContentError('CONTENT_LOCKED', 409);
  if (item.status === requested) return itemView(item, pool);
  const allowed: Record<string, string[]> = { DRAFT: ['READY', 'ARCHIVED', 'TRASHED'], READY: ['DRAFT', 'DISABLED', 'ARCHIVED'],
    DISABLED: ['DRAFT', 'READY', 'ARCHIVED', 'TRASHED'], ARCHIVED: ['DRAFT', 'TRASHED'], TRASHED: ['DRAFT'] };
  if (!allowed[item.status]?.includes(requested)) throw new ContentError('INVALID_CONTENT_TRANSITION', 409);
  if (requested === 'READY') {
    const validation = validateContentPayload(item.gameSlug, JSON.parse(item.payloadJson));
    if (!validation.success) throw new ContentError('CONTENT_NOT_READY', 400, validation.error.issues);
    if (['PUBLIC', 'SYSTEM'].includes(pool.scope) && (!item.source || !item.license || item.reviewState !== 'APPROVED')) throw new ContentError('PUBLIC_APPROVAL_REQUIRED', 403);
    await validateTagIds(db, itemView(item, pool).effective.tagIds);
  }
  const status = requested === 'TRASHED' && await db.contentUse.count({ where: { itemId: id } }) ? 'ARCHIVED' : requested;
  if (preview) return { ...itemView(item, pool), status };
  const updated = await db.contentItem.update({ where: { id, revision }, data: { status, revision: { increment: 1 } } });
  await saveRevision(db, updated, actor, 'STATUS', ['status']); return itemView(updated, pool);
}
export type BatchInput = z.infer<typeof ContentBatchSchema>;
async function batchContext(db: ContentDb, actor: ContentActor, input: BatchInput) {
  const pool = await requirePool(db, input.poolId, actor, true);
  if (pool.revision !== input.poolRevision) throw new ContentError('REVISION_CONFLICT', 409);
  if (new Set(input.items.map(i => i.id)).size !== input.items.length) throw new ContentError('INVALID_CONTENT_SELECTION');
  const operation = input.operation;
  if (operation.kind === 'TAGS') await validateTagIds(db, operation.tagIds ?? []);
  if (operation.kind === 'COPY' || operation.kind === 'MOVE') {
    const target = await requirePool(db, operation.targetPoolId, actor, true);
    if (target.revision !== operation.targetRevision) throw new ContentError('REVISION_CONFLICT', 409);
    if (target.gameSlug !== pool.gameSlug || target.scope !== 'PRIVATE' || target.id === pool.id) throw new ContentError('SCOPE_VIOLATION');
  }
  return pool;
}
async function batchItem(db: ContentDb, actor: ContentActor, input: BatchInput, ref: BatchInput['items'][number]) {
  const item = await db.contentItem.findFirst({ where: { id: ref.id, poolId: input.poolId } });
  if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  if (item.revision !== ref.revision) throw new ContentError('REVISION_CONFLICT', 409);
  if (item.lockState !== 'EDITABLE') throw new ContentError('CONTENT_LOCKED', 409);
  // Validate every domain precondition before an item's first write. Partial
  // failures are business errors; infrastructure failures roll back the batch.
  return item;
}
export async function previewBatch(db: ContentDb, actor: ContentActor, input: BatchInput) {
  await batchContext(db, actor, input);
  const rows = [];
  for (const ref of input.items) {
    try {
      const item = await batchItem(db, actor, input, ref);
      if (input.operation.kind === 'STATUS') await setItemStatus(db, actor, item.id, ref.revision, input.operation.status, true);
      const uses = await db.contentUse.count({ where: { itemId: item.id } });
      rows.push({ id: item.id, title: item.title, revision: item.revision, status: item.status, uses,
        effect: input.operation.kind === 'STATUS' ? input.operation.status === 'TRASHED' && uses ? 'ARCHIVED' : input.operation.status
          : input.operation.kind === 'MOVE' || input.operation.kind === 'COPY' ? 'DRAFT_IN_TARGET' : 'DRAFT', error: null });
    } catch (e) { if (!(e instanceof ContentError)) throw e; rows.push({ id: ref.id, title: '', revision: ref.revision, uses: 0, effect: null, error: e.code }); }
  }
  return { rows, total: rows.length, eligible: rows.filter(r => !r.error).length, historicallyUsed: rows.filter(r => r.uses > 0).length };
}
export async function commitBatch(db: ContentDb, actor: ContentActor, input: BatchInput) {
  const pool = await batchContext(db, actor, input), results = [];
  for (const ref of input.items) {
    try {
      const item = await batchItem(db, actor, input, ref), op = input.operation;
      if (op.kind === 'STATUS') {
        const updated = await setItemStatus(db, actor, item.id, ref.revision, op.status);
        results.push({ id: item.id, status: 'UPDATED', item: updated }); continue;
      }
      if (op.kind === 'TAGS' || op.kind === 'DIFFICULTY') {
        const view = itemView(item, pool);
        const updated = await changeItem(db, actor, item.id, ref.revision, ContentItemInputSchema.parse({ title: view.title, payload: view.payload,
          language: view.language, difficulty: op.kind === 'DIFFICULTY' ? op.difficulty : view.difficulty,
          tagIds: op.kind === 'TAGS' ? op.tagIds : view.tagIds, source: view.source, sourceUrl: view.sourceUrl, license: view.license }));
        results.push({ id: item.id, status: 'UPDATED', item: updated }); continue;
      }
      const target = await requirePool(db, op.targetPoolId, actor, true);
      const view = itemView(item, pool);
      // Materialize inheritance when moving/copying so a target's different
      // defaults never silently change language, difficulty or tags.
      const data = contentInputData({ title: view.title, payload: view.payload, ...view.effective, source: view.source, sourceUrl: view.sourceUrl, license: view.license });
      const updated = op.kind === 'COPY'
        ? await db.contentItem.create({ data: { ...data, poolId: target.id, gameSlug: item.gameSlug, duplicatedFromId: item.id } })
        : await db.contentItem.update({ where: { id: item.id, revision: ref.revision }, data: { ...data, poolId: target.id, status: 'DRAFT', reviewState: 'NOT_REVIEWED', revision: { increment: 1 } } });
      await saveRevision(db, updated, actor, op.kind, ['poolId']);
      results.push({ id: item.id, status: op.kind === 'COPY' ? 'COPIED' : 'MOVED', item: itemView(updated, target) });
    } catch (e) { if (!(e instanceof ContentError)) throw e; results.push({ id: ref.id, status: 'FAILED', error: e.code }); }
  }
  return { poolId: pool.id, results };
}
