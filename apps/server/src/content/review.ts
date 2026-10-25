import { z } from 'zod';
import { ContentItemInputSchema, validateContentPayload } from '@quiz/shared';
import { ContentError, contentInputData, itemView, requirePool, validateTagIds, saveRevision, auditContent,
  type ContentDb, type ContentActor } from './core.js';
import { canonicalContent } from './importExport.js';

export async function notifyContent(db: ContentDb, userId: string | null, poolId: string, kind: string, message: string, itemId?: string) {
  if (userId) await db.contentNotification.create({ data: { userId, poolId, kind, message, itemId } });
}
export async function requestPublicPool(db: ContentDb, actor: ContentActor, poolId: string, revision: number) {
  const pool = await requirePool(db, poolId, actor, true);
  if (pool.ownerId !== actor.userId && actor.role !== 'ADMIN') throw new ContentError('OWNERSHIP_REQUIRED', 403);
  if (pool.revision !== revision) throw new ContentError('REVISION_CONFLICT', 409);
  if (!['PRIVATE', 'SHARED'].includes(pool.scope)) throw new ContentError('SCOPE_VIOLATION');
  const items = await db.contentItem.findMany({ where: { poolId, status: { notIn: ['ARCHIVED', 'TRASHED', 'DISABLED'] } } });
  if (!items.length) throw new ContentError('CONTENT_NOT_READY');
  for (const item of items) if (item.status !== 'READY' || !item.source || !item.license || !validateContentPayload(item.gameSlug, JSON.parse(item.payloadJson)).success) throw new ContentError('PUBLIC_REQUIREMENTS_MISSING');
  await db.contentPool.update({ where: { id: poolId, revision }, data: { status: 'LOCKED_REVIEW', revision: { increment: 1 } } });
  const proposal = await db.contentReview.create({ data: { poolId, actorId: actor.userId, baseRevision: revision + 1, kind: 'PUBLIC_POOL', proposedJson: JSON.stringify(items.map(i => ({ id: i.id, revision: i.revision }))) } });
  for (const admin of await db.user.findMany({ where: { role: 'ADMIN', disabledAt: null } })) await notifyContent(db, admin.id, poolId, 'PUBLIC_REVIEW', 'Ein Fragenpool wartet auf öffentliche Freigabe.');
  await auditContent(db, actor, 'CONTENT_PUBLIC_SUBMIT', poolId, { reviewId: proposal.id }); return { reviewId: proposal.id };
}
export async function proposeItemChange(db: ContentDb, actor: ContentActor, itemId: string, revision: number, raw: unknown) {
  const item = await db.contentItem.findUnique({ where: { id: itemId } }); if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const pool = await requirePool(db, item.poolId, actor);
  const assigned = pool.scope === 'SHARED' && (JSON.parse(pool.editorIdsJson) as string[]).includes(actor.userId);
  if (actor.role !== 'ADMIN' && pool.ownerId !== actor.userId && !assigned) throw new ContentError('NOT_AUTHORIZED', 403);
  if (pool.status !== 'ACTIVE' || item.lockState !== 'EDITABLE') throw new ContentError('CONTENT_LOCKED', 409);
  if (item.revision !== revision) throw new ContentError('REVISION_CONFLICT', 409);
  const input = ContentItemInputSchema.parse(raw); await validateTagIds(db, input.tagIds ?? []);
  const validation = validateContentPayload(item.gameSlug, input.payload);
  if (!validation.success) throw new ContentError('CONTENT_NOT_READY', 400, validation.error.issues);
  const data = contentInputData(input), publicContent = ['PUBLIC', 'SYSTEM'].includes(pool.scope);
  if (publicContent && (!input.source || !input.license)) throw new ContentError('PUBLIC_REQUIREMENTS_MISSING');
  const currentRaw: unknown = JSON.parse(item.payloadJson), currentParsed = validateContentPayload(item.gameSlug, currentRaw);
  const current = currentParsed.success ? currentParsed.data : currentRaw;
  const gameplayChanged = canonicalContent(current) !== canonicalContent(validation.data) || input.language !== item.language || input.difficulty !== item.difficulty;
  if (publicContent && !gameplayChanged) {
    // Only non-gameplay metadata can bypass reapproval; payload differences
    // (including text changes) are conservatively reviewed.
    const changed = Object.keys(data).filter(k => data[k as keyof typeof data] !== item[k as keyof typeof item]);
    if (!changed.length) return { item: itemView(item, pool), kind: 'NO_CHANGE' };
    const updated = await db.contentItem.update({ where: { id: item.id, revision }, data: { ...data, revision: { increment: 1 } } });
    await saveRevision(db, updated, actor, 'PATCH', changed); return { item: itemView(updated, pool), kind: 'PATCH' };
  }
  const updated = await db.contentItem.update({ where: { id: item.id, revision }, data: { lockState: 'LOCKED_REVIEW',
    ...(publicContent ? {} : { reviewState: 'IN_REVIEW' }), revision: { increment: 1 } } });
  await saveRevision(db, updated, actor, 'REVIEW_SUBMIT', ['lockState', 'reviewState']);
  const review = await db.contentReview.create({ data: { poolId: pool.id, itemId, actorId: actor.userId, baseRevision: updated.revision,
    kind: publicContent ? 'CONTENT_CHANGE' : 'ITEM_REVIEW', proposedJson: JSON.stringify(input) } });
  const recipients = publicContent ? (await db.user.findMany({ where: { role: 'ADMIN', disabledAt: null } })).map(u => u.id) : [pool.ownerId];
  for (const id of recipients) await notifyContent(db, id, pool.id, 'ITEM_REVIEW', 'Eine Frage wartet auf Prüfung.', itemId);
  return { reviewId: review.id, item: itemView(updated, pool), kind: review.kind };
}
export async function decideContentReview(db: ContentDb, actor: ContentActor, reviewId: string, approve: boolean, reason: string) {
  const review = await db.contentReview.findUnique({ where: { id: reviewId } }); if (!review) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const pool = await requirePool(db, review.poolId, actor);
  if (review.status !== 'IN_REVIEW') throw new ContentError('REVIEW_ALREADY_RESOLVED', 409);
  const publicReview = review.kind === 'PUBLIC_POOL' || ['PUBLIC', 'SYSTEM'].includes(pool.scope);
  if (publicReview ? actor.role !== 'ADMIN' : actor.role !== 'ADMIN' && pool.ownerId !== actor.userId) throw new ContentError('NOT_AUTHORIZED', 403);
  if (review.kind === 'PUBLIC_POOL') {
    if (pool.revision !== review.baseRevision || pool.status !== 'LOCKED_REVIEW') throw new ContentError('REVISION_CONFLICT', 409);
    const expected = JSON.parse(review.proposedJson) as Array<{ id: string; revision: number }>;
    if (approve) for (const ref of expected) {
      const item = await db.contentItem.findFirst({ where: { id: ref.id, poolId: pool.id, revision: ref.revision, status: 'READY' } });
      if (!item || !item.source || !item.license || !validateContentPayload(item.gameSlug, JSON.parse(item.payloadJson)).success) throw new ContentError('CONTENT_NOT_READY');
      const updated = await db.contentItem.update({ where: { id: item.id, revision: item.revision }, data: { reviewState: 'APPROVED', revision: { increment: 1 } } });
      await saveRevision(db, updated, actor, 'PUBLIC_APPROVAL', ['reviewState']);
    }
    await db.contentPool.update({ where: { id: pool.id, revision: review.baseRevision }, data: { ...(approve ? { scope: 'PUBLIC', editorIdsJson: '[]' } : {}), status: 'ACTIVE', revision: { increment: 1 } } });
  } else if (review.kind !== 'CORRECTION' || approve) {
    const item = await db.contentItem.findFirst({ where: { id: review.itemId!, poolId: pool.id } });
    if (!item || item.revision !== review.baseRevision) throw new ContentError('REVISION_CONFLICT', 409);
    const proposed = review.kind === 'CORRECTION' ? (() => {
      const correction = z.object({ field: z.string(), currentValue: z.string(), proposedValue: z.string() }).passthrough().parse(JSON.parse(review.proposedJson));
      const payload = JSON.parse(item.payloadJson);
      if (payload[correction.field] !== correction.currentValue) throw new ContentError('REVISION_CONFLICT', 409);
      return { ...itemView(item, pool), payload: { ...payload, [correction.field]: correction.proposedValue } };
    })() : JSON.parse(review.proposedJson);
    const data: Partial<ReturnType<typeof contentInputData>> = approve ? contentInputData(ContentItemInputSchema.parse({ title: proposed.title, payload: proposed.payload, language: proposed.language,
      difficulty: proposed.difficulty, tagIds: proposed.tagIds, source: proposed.source, sourceUrl: proposed.sourceUrl, license: proposed.license })) : {};
    if (approve && !validateContentPayload(item.gameSlug, JSON.parse(data.payloadJson!)).success) throw new ContentError('CONTENT_NOT_READY');
    if (approve && publicReview && (!data.source || !data.license)) throw new ContentError('PUBLIC_REQUIREMENTS_MISSING');
    const updated = await db.contentItem.update({ where: { id: item.id, revision: review.baseRevision }, data: { ...data, lockState: 'EDITABLE',
      reviewState: publicReview ? 'APPROVED' : approve ? 'APPROVED' : 'CHANGES_REQUESTED',
      ...(approve ? { status: publicReview ? 'READY' : 'DRAFT' } : {}), revision: { increment: 1 } } });
    await saveRevision(db, updated, actor, approve ? 'REVIEW_APPROVE' : 'REVIEW_REJECT', ['payloadJson', 'reviewState', 'lockState']);
  }
  await db.contentReview.update({ where: { id: review.id, status: 'IN_REVIEW' }, data: { status: approve ? 'APPROVED' : 'CHANGES_REQUESTED', reason, reviewerId: actor.userId, resolvedAt: new Date() } });
  await notifyContent(db, pool.ownerId, pool.id, 'REVIEW_RESULT', approve ? 'Die Prüfung wurde freigegeben.' : `Änderungen angefordert: ${reason}`, review.itemId ?? undefined);
  await auditContent(db, actor, 'CONTENT_REVIEW_DECISION', pool.id, { reviewId, approve, reason }); return { reviewId, status: approve ? 'APPROVED' : 'CHANGES_REQUESTED' };
}
