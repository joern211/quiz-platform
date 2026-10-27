import { CONTENT_TEMPLATES, ContentItemInputSchema, type ContentTemplateView } from '@quiz/shared';
import { ContentError, requirePool, validateTagIds, contentInputData, saveRevision, itemView, auditContent, type ContentActor, type ContentDb } from './core.js';
import { requireContributor } from './operations.js';
import { notifyContent } from './review.js';

export async function contentTemplateCatalog(db: ContentDb, actor: ContentActor, gameSlug: string): Promise<ContentTemplateView[]> {
  const system = CONTENT_TEMPLATES[gameSlug as keyof typeof CONTENT_TEMPLATES]; if (!system) throw new ContentError('CONTENT_GAME_UNSUPPORTED');
  const rows = await db.contentTemplate.findMany({ where: { ownerId: actor.userId, gameSlug, status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' } });
  return [{ id: `system:${gameSlug}:quick`, name: gameSlug === 'wissensduell' ? 'Schnelle Wissensfrage' : 'Schnelles Jeopardy-Feld', scope: 'SYSTEM', gameSlug, revision: 1, item: ContentItemInputSchema.parse(system) },
    ...rows.map(r => ({ id: r.id, name: r.name, scope: 'PRIVATE' as const, gameSlug, revision: r.revision, item: ContentItemInputSchema.parse(JSON.parse(r.itemJson)) }))];
}
export async function instantiateContentTemplate(db: ContentDb, actor: ContentActor, templateId: string, templateRevision: number, poolId: string, poolRevision: number) {
  const pool = await requirePool(db, poolId, actor, true);
  if (pool.revision !== poolRevision) throw new ContentError('REVISION_CONFLICT', 409);
  const template = (await contentTemplateCatalog(db, actor, pool.gameSlug)).find(t => t.id === templateId);
  if (!template) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  if (template.revision !== templateRevision) throw new ContentError('REVISION_CONFLICT', 409);
  await validateTagIds(db, template.item.tagIds ?? []);
  const item = await db.contentItem.create({ data: { ...contentInputData(template.item), poolId, gameSlug: pool.gameSlug } });
  await saveRevision(db, item, actor, 'TEMPLATE', Object.keys(template.item));
  await auditContent(db, actor, 'CONTENT_TEMPLATE_USE', item.id, { templateId, templateRevision });
  return itemView(item, pool);
}
export async function assignReview(db: ContentDb, actor: ContentActor, input: { itemId: string; itemRevision: number; assigneeId: string; note: string; assignmentRevision: number | null }) {
  const item = await db.contentItem.findUnique({ where: { id: input.itemId } }); if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const pool = await requirePool(db, item.poolId, actor); requireContributor(pool, actor);
  if (actor.role !== 'ADMIN' && pool.ownerId !== actor.userId) throw new ContentError('OWNERSHIP_REQUIRED', 403);
  if (item.revision !== input.itemRevision) throw new ContentError('REVISION_CONFLICT', 409);
  const assignee = await db.user.findFirst({ where: { id: input.assigneeId, disabledAt: null, role: { in: ['HOST', 'ADMIN'] } } });
  if (!assignee) throw new ContentError('INVALID_EDITOR');
  requireContributor(pool, { ...actor, userId: assignee.id, role: assignee.role });
  const old = await db.contentReviewAssignment.findUnique({ where: { itemId_assigneeId: { itemId: item.id, assigneeId: assignee.id } } });
  if ((old?.revision ?? null) !== input.assignmentRevision) throw new ContentError('REVISION_CONFLICT', 409);
  const data = { poolId: pool.id, note: input.note, itemRevision: item.revision, status: 'OPEN', completedAt: null, assignedBy: actor.userId };
  const row = old ? await db.contentReviewAssignment.update({ where: { id: old.id, revision: old.revision }, data: { ...data, revision: { increment: 1 } } })
    : await db.contentReviewAssignment.create({ data: { ...data, itemId: item.id, poolId: pool.id, assigneeId: assignee.id } });
  await auditContent(db, actor, 'CONTENT_REVIEW_ASSIGN', item.id, { assignmentId: row.id, assigneeId: assignee.id, revision: row.revision, itemRevision: item.revision });
  await notifyContent(db, assignee.id, pool.id, 'REVIEW_ASSIGNMENT', 'Dir wurde eine interne Fragenprüfung zugewiesen.', item.id); return row;
}
export async function advanceAssignment(db: ContentDb, actor: ContentActor, id: string, revision: number, status: 'IN_REVIEW' | 'DONE') {
  const row = await db.contentReviewAssignment.findUnique({ where: { id } }); if (!row) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const item = await db.contentItem.findUnique({ where: { id: row.itemId } }); if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const pool = await requirePool(db, item.poolId, actor); requireContributor(pool, actor);
  if (actor.role !== 'ADMIN' && actor.userId !== row.assigneeId) throw new ContentError('NOT_AUTHORIZED', 403);
  if (row.revision !== revision || row.itemRevision !== item.revision || row.poolId !== item.poolId) throw new ContentError('REVISION_CONFLICT', 409);
  if (row.status !== (status === 'IN_REVIEW' ? 'OPEN' : 'IN_REVIEW')) throw new ContentError('INVALID_REVIEW_TRANSITION', 409);
  const updated = await db.contentReviewAssignment.update({ where: { id, revision }, data: { status, revision: { increment: 1 }, completedAt: status === 'DONE' ? new Date() : null } });
  await auditContent(db, actor, 'CONTENT_REVIEW_TASK_STATUS', item.id, { assignmentId: id, status, itemRevision: item.revision });
  if (status === 'DONE') await notifyContent(db, pool.ownerId, pool.id, 'REVIEW_ASSIGNMENT_DONE', 'Eine interne Fragenprüfung wurde abgeschlossen. Der Inhalt wurde dadurch nicht freigegeben.', item.id);
  return updated;
}
