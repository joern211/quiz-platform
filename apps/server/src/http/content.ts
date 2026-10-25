import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ContentItemInputSchema, CreateContentPoolSchema, ContentDefaultsSchema, ContentStatusSchema, CONTENT_TEMPLATES,
  ContentGameSchema, ContentBatchSchema } from '@quiz/shared';
import { prisma } from '../persistence/prisma.js';
import { verifySession } from '../auth/session.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { parseContentImport, previewContentImport, commitContentImport, ImportCommitSchema, exportContent } from '../content/importExport.js';
import { requestPublicPool, proposeItemChange, decideContentReview, notifyContent } from '../content/review.js';
import { CorrectionAccessSchema, CorrectionSubmitSchema, eligibleCorrectionContent, submitContentCorrection } from '../content/corrections.js';
import { ContentError, contentActor, canReadPool, requirePool, poolView, itemView, validateTagIds, contentInputData,
  mutateContent, saveRevision, changeItem, auditContent, type ContentActor, type ContentDb } from '../content/core.js';

import { contentMediaUrl, validateContentMedia } from '../content/media.js';
import { setItemStatus, previewBatch, commitBatch, requireContributor } from '../content/operations.js';

export const contentRouter: ReturnType<typeof Router> = Router();
const command = z.object({ commandId: z.string().uuid() });
const revisionCommand = command.extend({ revision: z.number().int().positive() });
const session = (req: Request) => verifySession(req, config.sessionSecret);
function endpoint(action: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await action(req, res); } catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ success: false, error: { code: 'INVALID_CONTENT', message: 'Eingaben prüfen.', details: error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) } }); return; }
      if (error instanceof ContentError) { const messages: Record<string, string> = { MEDIA_NOT_ACCESSIBLE: 'Dieses Medium ist nicht verfügbar oder für dich nicht freigegeben.', MEDIA_NOT_READY: 'Das Medium ist noch nicht spielbereit. Bitte Datei und Verarbeitung prüfen.', MEDIA_RIGHTS_REQUIRED: 'Bitte Medienquelle, Nutzungsrechte und gegebenenfalls Einwilligung ergänzen.' }; res.status(error.status).json({ success: false, error: { code: error.code, message: messages[error.code] ?? error.code, details: error.details } }); return; }
      // ORM exception messages may contain complete payloads/answers.
      logger.error('Content request failed', { method: req.method, errorType: error instanceof Error ? error.name : 'Unknown' });
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Inhalte konnten nicht verarbeitet werden.' } });
    }
  };
}
async function itemAccess(db: ContentDb, actor: ContentActor, id: string, edit = false) {
  const item = await db.contentItem.findUnique({ where: { id } });
  if (!item) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const pool = await requirePool(db, item.poolId, actor, edit);
  if (['PUBLIC', 'SYSTEM'].includes(pool.scope) && actor.role !== 'ADMIN' && pool.ownerId !== actor.userId && item.status !== 'READY') throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  return { item, pool };
}
contentRouter.get('/templates', endpoint(async (req, res) => {
  await contentActor(prisma, session(req)); res.json({ success: true, data: CONTENT_TEMPLATES });
}));
contentRouter.post('/corrections/eligible', endpoint(async (req, res) => {
  res.json({ success: true, data: await eligibleCorrectionContent(prisma, CorrectionAccessSchema.strict().parse(req.body)) });
}));
contentRouter.post('/corrections', endpoint(async (req, res) => {
  res.status(201).json({ success: true, data: await submitContentCorrection(CorrectionSubmitSchema.parse(req.body)) });
}));
contentRouter.get('/pools', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req));
  const pools = await prisma.contentPool.findMany({ where: { status: { in: ['ACTIVE', 'LOCKED_REVIEW'] }, ...(req.query.gameSlug ? { gameSlug: ContentGameSchema.parse(req.query.gameSlug) } : {}) }, orderBy: { updatedAt: 'desc' } });
  res.json({ success: true, data: pools.filter(p => canReadPool(p, actor)).map(p => poolView(p, actor)) });
}));
contentRouter.post('/pools', endpoint(async (req, res) => {
  const input = CreateContentPoolSchema.parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'CREATE_POOL', input }, async (db, actor) => {
    await validateTagIds(db, input.defaults.tagIds);
    if (input.editorIds.length && input.scope !== 'SHARED') throw new ContentError('SCOPE_VIOLATION');
    if (await db.user.count({ where: { id: { in: input.editorIds }, role: { in: ['HOST', 'ADMIN'] }, disabledAt: null } }) !== new Set(input.editorIds).size) throw new ContentError('INVALID_EDITOR');
    const pool = await db.contentPool.create({ data: { name: input.name, gameSlug: input.gameSlug, description: input.description,
      ownerId: actor.userId, scope: input.scope, editorIdsJson: JSON.stringify([...new Set(input.editorIds)]), defaultsJson: JSON.stringify(input.defaults) } });
    await auditContent(db, actor, 'CONTENT_POOL_CREATE', pool.id, { scope: pool.scope }); return poolView(pool, actor);
  });
  res.status(201).json({ success: true, data });
}));
contentRouter.get('/pools/:id', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)); const pool = await requirePool(prisma, String(req.params.id), actor);
  const rows = await prisma.contentItem.findMany({ where: { poolId: pool.id,
    ...(['PUBLIC', 'SYSTEM'].includes(pool.scope) && actor.role !== 'ADMIN' && pool.ownerId !== actor.userId ? { status: 'READY' } : {}) }, orderBy: { updatedAt: 'desc' } });
  const query = String(req.query.q ?? '').toLocaleLowerCase();
  const items = rows.map(i => itemView(i, pool)).filter(i => (!req.query.status || i.status === req.query.status) &&
    (!req.query.difficulty || i.effective.difficulty === req.query.difficulty) &&
    (!req.query.tagId || i.effective.tagIds.includes(String(req.query.tagId))) &&
    (!query || `${i.title} ${JSON.stringify(i.payload)}`.toLocaleLowerCase().includes(query)));
  res.json({ success: true, data: { pool: poolView(pool, actor), items } });
}));
contentRouter.get('/pools/:id/editors', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)), pool = await requirePool(prisma, String(req.params.id), actor);
  if (actor.role !== 'ADMIN' && pool.ownerId !== actor.userId) throw new ContentError('OWNERSHIP_REQUIRED', 403);
  res.json({ success: true, data: await prisma.user.findMany({ where: { id: { in: JSON.parse(pool.editorIdsJson) as string[] } }, select: { id: true, displayName: true } }) });
}));
contentRouter.put('/pools/:id', endpoint(async (req, res) => {
  const input = revisionCommand.extend({ name: z.string().trim().min(1).max(150), description: z.string().max(2000), defaults: ContentDefaultsSchema,
    scope: z.enum(['PRIVATE', 'SHARED']), editorIds: z.array(z.string().min(1).max(128)).max(30) }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'EDIT_POOL', id: String(req.params.id), input }, async (db, actor) => {
    const pool = await requirePool(db, String(req.params.id), actor, true);
    if (pool.ownerId !== actor.userId && actor.role !== 'ADMIN') throw new ContentError('OWNERSHIP_REQUIRED', 403);
    if (pool.revision !== input.revision) throw new ContentError('REVISION_CONFLICT', 409);
    if (input.editorIds.length && input.scope !== 'SHARED') throw new ContentError('SCOPE_VIOLATION');
    await validateTagIds(db, input.defaults.tagIds);
    if (await db.user.count({ where: { id: { in: input.editorIds }, role: { in: ['HOST', 'ADMIN'] }, disabledAt: null } }) !== new Set(input.editorIds).size) throw new ContentError('INVALID_EDITOR');
    const updated = await db.contentPool.update({ where: { id: pool.id, revision: input.revision }, data: { name: input.name, description: input.description,
      defaultsJson: JSON.stringify(input.defaults), scope: input.scope, editorIdsJson: JSON.stringify([...new Set(input.editorIds)]), revision: { increment: 1 } } });
    await auditContent(db, actor, 'CONTENT_POOL_EDIT', pool.id, { revision: updated.revision }); return poolView(updated, actor);
  }); res.json({ success: true, data });
}));
contentRouter.post('/pools/:id/fork', endpoint(async (req, res) => {
  const input = command.strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'FORK', id: String(req.params.id) }, async (db, actor) => {
    const source = await requirePool(db, String(req.params.id), actor);
    const pool = await db.contentPool.create({ data: { name: `${source.name} (Kopie)`, description: source.description, ownerId: actor.userId,
      gameSlug: source.gameSlug, scope: 'PRIVATE', defaultsJson: source.defaultsJson, forkedFromPoolId: source.id } });
    const items = await db.contentItem.findMany({ where: { poolId: source.id, status: ['PUBLIC', 'SYSTEM'].includes(source.scope) && actor.role !== 'ADMIN' && source.ownerId !== actor.userId ? 'READY' : { not: 'TRASHED' } } });
    for (const old of items) {
      const item = await db.contentItem.create({ data: { ...contentInputData(contentInputDataToView(JSON.stringify(old))), gameSlug: old.gameSlug,
        poolId: pool.id, duplicatedFromId: old.id } });
      await saveRevision(db, item, actor, 'DUPLICATE', ['poolId']);
    }
    await auditContent(db, actor, 'CONTENT_POOL_FORK', pool.id, { sourceId: source.id }); return poolView(pool, actor);
  }); res.status(201).json({ success: true, data });
}));
contentRouter.post('/pools/:id/items', endpoint(async (req, res) => {
  const input = command.extend({ item: ContentItemInputSchema }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'CREATE_ITEM', id: String(req.params.id), input }, async (db, actor) => {
    const pool = await requirePool(db, String(req.params.id), actor, true); await validateTagIds(db, input.item.tagIds ?? []);
    await validateContentMedia(db, actor, input.item.payload);
    const item = await db.contentItem.create({ data: { ...contentInputData(input.item), poolId: pool.id, gameSlug: pool.gameSlug } });
    await saveRevision(db, item, actor, 'CREATE', Object.keys(input.item)); return itemView(item, pool);
  }); res.status(201).json({ success: true, data });
}));
contentRouter.get('/items/:id', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)); const { item, pool } = await itemAccess(prisma, actor, String(req.params.id));
  res.json({ success: true, data: itemView(item, pool) });
}));
contentRouter.put('/items/:id', endpoint(async (req, res) => {
  const input = revisionCommand.extend({ item: ContentItemInputSchema }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'EDIT_ITEM', id: String(req.params.id), input }, (db, actor) => changeItem(db, actor, String(req.params.id), input.revision, input.item));
  res.json({ success: true, data });
}));
contentRouter.post('/items/:id/status', endpoint(async (req, res) => {
  const input = revisionCommand.extend({ status: ContentStatusSchema }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'STATUS', id: String(req.params.id), input },
    (db, actor) => setItemStatus(db, actor, String(req.params.id), input.revision, input.status)); res.json({ success: true, data });
}));
contentRouter.get('/items/:id/history', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)); const { item } = await itemAccess(prisma, actor, String(req.params.id));
  const rows = await prisma.contentRevision.findMany({ where: { itemId: item.id }, orderBy: { revision: 'desc' } });
  res.json({ success: true, data: rows.map(row => ({ revision: row.revision, kind: row.kind, actorId: row.actorId, createdAt: row.createdAt,
    changedFields: JSON.parse(row.changedFieldsJson), snapshot: contentInputDataToView(row.snapshotJson) })) });
}));
function contentInputDataToView(json: string) {
  const v = JSON.parse(json); return { title: v.title, payload: JSON.parse(v.payloadJson), language: v.language, difficulty: v.difficulty,
    tagIds: v.tagIdsJson === null ? null : JSON.parse(v.tagIdsJson), source: v.source, sourceUrl: v.sourceUrl, license: v.license };
}
contentRouter.post('/items/:id/restore', endpoint(async (req, res) => {
  const input = revisionCommand.extend({ targetRevision: z.number().int().positive() }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'RESTORE', id: String(req.params.id), input }, async (db, actor) => {
    await itemAccess(db, actor, String(req.params.id), true);
    const previous = await db.contentRevision.findUnique({ where: { itemId_revision: { itemId: String(req.params.id), revision: input.targetRevision } } });
    if (!previous) throw new ContentError('REVISION_NOT_FOUND', 404);
    return changeItem(db, actor, String(req.params.id), input.revision, contentInputDataToView(previous.snapshotJson), true);
  }); res.json({ success: true, data });
}));
contentRouter.post('/items/:id/duplicate', endpoint(async (req, res) => {
  const input = command.extend({ targetPoolId: z.string().min(1) }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'DUPLICATE', id: String(req.params.id), input }, async (db, actor) => {
    const { item } = await itemAccess(db, actor, String(req.params.id));
    const pool = await requirePool(db, input.targetPoolId, actor, true);
    if (pool.gameSlug !== item.gameSlug || pool.scope !== 'PRIVATE') throw new ContentError('SCOPE_VIOLATION');
    const copy = await db.contentItem.create({ data: { ...contentInputData(contentInputDataToView(JSON.stringify(item))), gameSlug: item.gameSlug,
      poolId: pool.id, duplicatedFromId: item.id } });
    await saveRevision(db, copy, actor, 'DUPLICATE', ['poolId']); return itemView(copy, pool);
  }); res.status(201).json({ success: true, data });
}));
contentRouter.get('/items/:id/preview', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)); const { item } = await itemAccess(prisma, actor, String(req.params.id));
  const role = z.enum(['HOST', 'PLAYER', 'VIEWER', 'TEAM']).parse(req.query.role ?? 'PLAYER');
  const reveal = req.query.reveal === 'true'; const payload = JSON.parse(item.payloadJson);
  const visible = item.gameSlug === 'wissensduell' ? { prompt: payload.prompt, category: payload.category, options: payload.options,
    ...((reveal || role === 'HOST') ? { correctOptionId: payload.correctOptionId, explanation: payload.explanation } : {}) }
    : { question: payload.question, category: payload.category, value: payload.value, ...((reveal || role === 'HOST') ? { answer: payload.answer } : {}) };
  if (typeof payload.mediaAssetId === 'string') await validateContentMedia(prisma, actor, payload);
  const media = typeof payload.mediaAssetId === 'string' ? { mediaType: payload.mediaType,
    mediaUrl: contentMediaUrl(payload.mediaAssetId, { kind: 'EDITOR', itemId: item.id, revision: item.revision }) } : {};
  res.json({ success: true, data: { ...visible, ...media } });
}));
contentRouter.get('/tags', endpoint(async (req, res) => {
  await contentActor(prisma, session(req)); res.json({ success: true, data: await prisma.contentTag.findMany({ orderBy: { name: 'asc' } }) });
}));
contentRouter.get('/editors/search', endpoint(async (req, res) => {
  await contentActor(prisma, session(req)); const query = z.string().trim().min(3).max(100).parse(req.query.q);
  res.json({ success: true, data: await prisma.user.findMany({ where: { disabledAt: null, role: { in: ['HOST', 'ADMIN'] },
    OR: [{ displayName: { contains: query } }, { email: query }] }, select: { id: true, displayName: true }, take: 10 }) });
}));
contentRouter.put('/tags/:id/aliases', endpoint(async (req, res) => {
  const input = command.extend({ aliases: z.array(z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80)).max(20) }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'TAG_ALIASES', id: req.params.id, input }, async (db, actor) => {
    if (actor.role !== 'ADMIN') throw new ContentError('NOT_AUTHORIZED', 403);
    const all = await db.contentTag.findMany(), tag = all.find(t => t.id === req.params.id); if (!tag) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
    if (new Set(input.aliases).size !== input.aliases.length || input.aliases.some(alias => all.some(t => t.id !== tag.id && (t.slug === alias || (JSON.parse(t.aliasesJson) as string[]).includes(alias))))) throw new ContentError('TAG_ALIAS_CONFLICT', 409);
    const updated = await db.contentTag.update({ where: { id: tag.id }, data: { aliasesJson: JSON.stringify(input.aliases) } }); await auditContent(db, actor, 'CONTENT_TAG_ALIASES', tag.id, { aliases: input.aliases }); return updated;
  }); res.json({ success: true, data });
}));
contentRouter.post('/tags', endpoint(async (req, res) => {
  const input = command.extend({ name: z.string().trim().min(1).max(80), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80) }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'TAG_CREATE', input }, async (db, actor) => {
    const existing = await db.contentTag.findUnique({ where: { slug: input.slug } }); if (existing) return existing;
    if ((await db.contentTag.findMany()).some(t => (JSON.parse(t.aliasesJson) as string[]).includes(input.slug))) throw new ContentError('TAG_ALIAS_CONFLICT', 409);
    const tag = await db.contentTag.create({ data: { name: input.name, slug: input.slug } }); await auditContent(db, actor, 'CONTENT_TAG_CREATE', tag.id, {}); return tag;
  }); res.status(201).json({ success: true, data });
}));

contentRouter.post('/pools/:id/import/preview', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req));
  const pool = await requirePool(prisma, String(req.params.id), actor, true);
  const input = z.object({ format: z.enum(['JSON', 'CSV', 'XLSX']), fileBase64: z.string().max(7 * 1024 * 1024) }).strict().parse(req.body);
  const rows = await parseContentImport(input.format, Buffer.from(input.fileBase64, 'base64'), pool.gameSlug);
  const result = await prisma.$transaction(async db => {
    const liveActor = await contentActor(db, session(req));
    const preview = await previewContentImport(db, liveActor, pool.id, rows);
    const draft = await db.contentImportDraft.create({ data: { poolId: pool.id, actorId: liveActor.userId, rowsJson: JSON.stringify(rows),
      previewJson: JSON.stringify(preview.rows), targetHash: preview.targetHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    return { importId: draft.id, rows: preview.rows };
  }); res.json({ success: true, data: result });
}));
contentRouter.post('/imports/commit', endpoint(async (req, res) => {
  const input = ImportCommitSchema.parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'IMPORT', input }, (db, actor) => commitContentImport(db, actor, input));
  res.json({ success: true, data });
}));
contentRouter.get('/pools/:id/export', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)), format = z.enum(['JSON', 'CSV', 'XLSX']).parse(req.query.format ?? 'JSON');
  const buffer = await exportContent(prisma, actor, String(req.params.id), format);
  res.setHeader('Content-Disposition', `attachment; filename="quiz-content.${format.toLocaleLowerCase()}"`);
  res.type(format === 'XLSX' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : format === 'CSV' ? 'text/csv' : 'application/json'); res.send(buffer);
}));

contentRouter.post('/pools/:id/submit-public', endpoint(async (req, res) => {
  const input = revisionCommand.strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'PUBLIC_SUBMIT', id: req.params.id, input },
    (db, actor) => requestPublicPool(db, actor, String(req.params.id), input.revision));
  res.json({ success: true, data });
}));
contentRouter.post('/items/:id/propose', endpoint(async (req, res) => {
  const input = revisionCommand.extend({ item: ContentItemInputSchema }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'PROPOSE', id: req.params.id, input },
    (db, actor) => proposeItemChange(db, actor, String(req.params.id), input.revision, input.item));
  res.json({ success: true, data });
}));
contentRouter.get('/reviews', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req));
  const all = await prisma.contentReview.findMany({ where: { status: 'IN_REVIEW' }, orderBy: { createdAt: 'asc' } });
  const visible = [];
  for (const row of all) {
    const pool = await prisma.contentPool.findUnique({ where: { id: row.poolId } });
    if (!pool || !canReadPool(pool, actor)) continue;
    const canDecide = actor.role === 'ADMIN' || (pool.ownerId === actor.userId && row.kind !== 'PUBLIC_POOL' && !['PUBLIC', 'SYSTEM'].includes(pool.scope));
    visible.push({ ...row, proposed: JSON.parse(row.proposedJson), poolName: pool.name, canDecide });
  } res.json({ success: true, data: visible });
}));
contentRouter.post('/reviews/:id/decide', endpoint(async (req, res) => {
  const input = command.extend({ approve: z.boolean(), reason: z.string().trim().max(2000) }).strict().refine(v => v.approve || v.reason.length > 0, 'Ablehnungsgrund erforderlich.').parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'REVIEW_DECIDE', id: req.params.id, input },
    (db, actor) => decideContentReview(db, actor, String(req.params.id), input.approve, input.reason));
  res.json({ success: true, data });
}));
contentRouter.get('/inbox', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req));
  res.json({ success: true, data: await prisma.contentNotification.findMany({ where: { userId: actor.userId }, orderBy: { createdAt: 'desc' }, take: 100 }) });
}));
contentRouter.post('/inbox/:id/read', endpoint(async (req, res) => {
  const input = command.strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'INBOX_READ', id: req.params.id }, async (db, actor) => {
    const row = await db.contentNotification.updateMany({ where: { id: String(req.params.id), userId: actor.userId, readAt: null }, data: { readAt: new Date() } }); return { updated: row.count };
  }); res.json({ success: true, data });
}));
contentRouter.get('/items/:id/comments', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)); const { pool } = await itemAccess(prisma, actor, String(req.params.id)); requireContributor(pool, actor);
  res.json({ success: true, data: await prisma.contentComment.findMany({ where: { itemId: String(req.params.id) }, orderBy: { createdAt: 'asc' } }) });
}));
contentRouter.post('/items/:id/comments', endpoint(async (req, res) => {
  const input = command.extend({ message: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'COMMENT', id: req.params.id, input }, async (db, actor) => {
    const { item, pool } = await itemAccess(db, actor, String(req.params.id));
    if (actor.role !== 'ADMIN' && pool.ownerId !== actor.userId && !(pool.scope === 'SHARED' && (JSON.parse(pool.editorIdsJson) as string[]).includes(actor.userId))) throw new ContentError('NOT_AUTHORIZED', 403);
    const comment = await db.contentComment.create({ data: { itemId: item.id, actorId: actor.userId, message: input.message } });
    await notifyContent(db, pool.ownerId, pool.id, 'REVIEW_COMMENT', 'Neuer interner Prüfkommentar.', item.id); return comment;
  }); res.status(201).json({ success: true, data });
}));
contentRouter.post('/comments/:id/resolve', endpoint(async (req, res) => {
  const input = command.extend({ status: z.enum(['OPEN', 'RESOLVED', 'REJECTED']) }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'COMMENT_RESOLVE', id: req.params.id, input }, async (db, actor) => {
    const comment = await db.contentComment.findUnique({ where: { id: String(req.params.id) } }); if (!comment) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
    const { pool } = await itemAccess(db, actor, comment.itemId); requireContributor(pool, actor);
    if (actor.role !== 'ADMIN' && pool.ownerId !== actor.userId && comment.actorId !== actor.userId) throw new ContentError('NOT_AUTHORIZED', 403);
    return db.contentComment.update({ where: { id: comment.id }, data: { status: input.status, resolvedAt: input.status === 'OPEN' ? null : new Date() } });
  }); res.json({ success: true, data });
}));
contentRouter.post('/items/:id/lock', endpoint(async (req, res) => {
  const input = revisionCommand.extend({ locked: z.boolean() }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'LOCK', id: req.params.id, input }, async (db, actor) => {
    const { item, pool } = await itemAccess(db, actor, String(req.params.id), true);
    if (actor.role !== 'ADMIN' && pool.ownerId !== actor.userId) throw new ContentError('OWNERSHIP_REQUIRED', 403);
    if (item.revision !== input.revision) throw new ContentError('REVISION_CONFLICT', 409);
    if (!['EDITABLE', 'LOCKED_MANUAL'].includes(item.lockState)) throw new ContentError('CONTENT_LOCKED', 409);
    const updated = await db.contentItem.update({ where: { id: item.id, revision: input.revision }, data: { lockState: input.locked ? 'LOCKED_MANUAL' : 'EDITABLE', revision: { increment: 1 } } });
    await saveRevision(db, updated, actor, 'LOCK', ['lockState']); return itemView(updated, pool);
  }); res.json({ success: true, data });
}));
contentRouter.get('/pools/:id/quality', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)), pool = await requirePool(prisma, String(req.params.id), actor);
  if (actor.role !== 'ADMIN' && pool.ownerId !== actor.userId && !poolView(pool, actor).canEdit) throw new ContentError('NOT_AUTHORIZED', 403);
  const rows = (await prisma.contentItem.findMany({ where: { poolId: pool.id } })).map(i => itemView(i, pool));
  const counts = Object.fromEntries(['DRAFT', 'READY', 'DISABLED', 'ARCHIVED', 'TRASHED'].map(s => [s, rows.filter(r => r.status === s).length]));
  const warnings = rows.filter(r => r.status !== 'TRASHED').flatMap(r => [
    ...(r.validation.length ? [{ itemId: r.id, kind: 'INVALID_CONTENT', state: 'PROBLEMATIC' }] : []),
    ...(!r.effective.tagIds.length ? [{ itemId: r.id, kind: 'MISSING_TAGS', state: 'CHECK' }] : []),
    ...(!r.source ? [{ itemId: r.id, kind: 'MISSING_SOURCE', state: 'CHECK' }] : []),
  ]);
  const duplicateCount = rows.length - new Set(rows.map(r => JSON.stringify(r.payload))).size;
  res.json({ success: true, data: { counts, warnings, duplicateCount, health: !counts.READY ? 'NICHT_SPIELBEREIT' : warnings.some(w => w.state === 'PROBLEMATIC') ? 'FEHLER' : warnings.length || duplicateCount ? 'HINWEISE' : 'OK',
    difficulty: Object.fromEntries(['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'].map(d => [d, rows.filter(r => r.effective.difficulty === d).length])),
    openComments: await prisma.contentComment.count({ where: { itemId: { in: rows.map(r => r.id) }, status: 'OPEN' } }) } });
}));

contentRouter.post('/batch/preview', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)), input = ContentBatchSchema.parse(req.body);
  res.json({ success: true, data: await previewBatch(prisma, actor, input) });
}));
contentRouter.post('/batch/commit', endpoint(async (req, res) => {
  const input = command.extend({ batch: ContentBatchSchema, confirmed: z.literal(true) }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'BATCH', input }, (db, actor) => commitBatch(db, actor, input.batch));
  res.json({ success: true, data });
}));
contentRouter.get('/items/:id/usage', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)), { item, pool } = await itemAccess(prisma, actor, String(req.params.id)); requireContributor(pool, actor);
  const uses = await prisma.contentUse.findMany({ where: { itemId: item.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  const rooms = await prisma.room.findMany({ where: { id: { in: uses.map(u => u.roomId) } }, select: { id: true, roomName: true, status: true } });
  res.json({ success: true, data: { pool: { id: pool.id, name: pool.name }, total: await prisma.contentUse.count({ where: { itemId: item.id } }),
    uses: uses.map(u => ({ runIndex: u.runIndex, itemRevision: u.itemRevision, createdAt: u.createdAt, room: rooms.find(r => r.id === u.roomId) ?? null })) } });
}));

contentRouter.post('/items/:id/presence', endpoint(async (req, res) => {
  const input = z.object({ editorKey: z.string().uuid(), active: z.boolean() }).strict().parse(req.body);
  const data = await prisma.$transaction(async db => {
    await db.$executeRaw`UPDATE sessions SET id = id WHERE 0`;
    const actor = await contentActor(db, session(req)), { item, pool } = await itemAccess(db, actor, String(req.params.id)); requireContributor(pool, actor);
    const key = { itemId: item.id, sessionId: actor.sessionId, editorKey: input.editorKey };
    if (input.active) await db.contentEditorPresence.upsert({ where: { itemId_sessionId_editorKey: key },
      create: { ...key, userId: actor.userId }, update: { lastSeenAt: new Date() } });
    else await db.contentEditorPresence.deleteMany({ where: key });
    const cutoff = new Date(Date.now() - 45000);
    await db.contentEditorPresence.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
    const rows = await db.contentEditorPresence.findMany({ where: { itemId: item.id, lastSeenAt: { gte: cutoff } } });
    const liveSessions = await db.session.findMany({ where: { id: { in: rows.map(r => r.sessionId) }, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } }, include: { user: true } });
    const userIds = [...new Set(rows.filter(r => liveSessions.some(s => s.id === r.sessionId) && !(r.sessionId === actor.sessionId && r.editorKey === input.editorKey)).map(r => r.userId))];
    const contributors = userIds.filter(id => { try { requireContributor(pool, { ...actor, userId: id, role: liveSessions.find(s => s.userId === id)?.user.role ?? '' }); return true; } catch { return false; } });
    return db.user.findMany({ where: { id: { in: contributors } }, select: { id: true, displayName: true } });
  }); res.json({ success: true, data });
}));

contentRouter.get('/items/:id/media', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req)), { item, pool } = await itemAccess(prisma, actor, String(req.params.id));
  const payload = JSON.parse(item.payloadJson); await validateContentMedia(prisma, actor, payload);
  const asset = typeof payload.mediaAssetId === 'string' ? await prisma.mediaAsset.findUnique({ where: { id: payload.mediaAssetId } }) : null;
  if (!asset || asset.processStatus !== 'READY') throw new ContentError('MEDIA_NOT_READY');
  if (['PUBLIC', 'SYSTEM'].includes(pool.scope) && actor.role !== 'ADMIN' && pool.ownerId !== actor.userId && item.reviewState !== 'APPROVED') throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  res.json({ success: true, data: { url: contentMediaUrl(asset.id, { kind: 'EDITOR', itemId: item.id, revision: item.revision }), type: asset.type } });
}));
