import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ContentItemInputSchema, CreateContentPoolSchema, ContentDefaultsSchema, ContentStatusSchema, CONTENT_TEMPLATES,
  ContentGameSchema, validateContentPayload } from '@quiz/shared';
import { prisma } from '../persistence/prisma.js';
import { verifySession } from '../auth/session.js';
import { config } from '../config/index.js';
import { logger } from '../observability/logger.js';
import { ContentError, contentActor, canReadPool, requirePool, poolView, itemView, validateTagIds, contentInputData,
  mutateContent, saveRevision, changeItem, auditContent, type ContentActor, type ContentDb } from '../content/core.js';

export const contentRouter: ReturnType<typeof Router> = Router();
const command = z.object({ commandId: z.string().uuid() });
const revisionCommand = command.extend({ revision: z.number().int().positive() });
const session = (req: Request) => verifySession(req, config.sessionSecret);
function endpoint(action: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await action(req, res); } catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ success: false, error: { code: 'INVALID_CONTENT', message: 'Eingaben prüfen.', details: error.issues.map(e => ({ path: e.path.join('.'), message: e.message })) } }); return; }
      if (error instanceof ContentError) { res.status(error.status).json({ success: false, error: { code: error.code, message: error.code, details: error.details } }); return; }
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
  return { item, pool };
}
contentRouter.get('/templates', endpoint(async (req, res) => {
  await contentActor(prisma, session(req)); res.json({ success: true, data: CONTENT_TEMPLATES });
}));
contentRouter.get('/pools', endpoint(async (req, res) => {
  const actor = await contentActor(prisma, session(req));
  const pools = await prisma.contentPool.findMany({ where: { status: 'ACTIVE', ...(req.query.gameSlug ? { gameSlug: ContentGameSchema.parse(req.query.gameSlug) } : {}) }, orderBy: { updatedAt: 'desc' } });
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
  const rows = await prisma.contentItem.findMany({ where: { poolId: pool.id }, orderBy: { updatedAt: 'desc' } });
  const query = String(req.query.q ?? '').toLocaleLowerCase();
  const items = rows.map(i => itemView(i, pool)).filter(i => (!req.query.status || i.status === req.query.status) &&
    (!req.query.difficulty || i.effective.difficulty === req.query.difficulty) &&
    (!req.query.tagId || i.effective.tagIds.includes(String(req.query.tagId))) &&
    (!query || `${i.title} ${JSON.stringify(i.payload)}`.toLocaleLowerCase().includes(query)));
  res.json({ success: true, data: { pool: poolView(pool, actor), items } });
}));
contentRouter.put('/pools/:id', endpoint(async (req, res) => {
  const input = revisionCommand.extend({ name: z.string().trim().min(1).max(150), description: z.string().max(2000), defaults: ContentDefaultsSchema,
    scope: z.enum(['PRIVATE', 'SHARED']), editorIds: z.array(z.string().uuid()).max(30) }).strict().parse(req.body);
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
    const items = await db.contentItem.findMany({ where: { poolId: source.id, status: { not: 'TRASHED' } } });
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
  const data = await mutateContent(session(req), input.commandId, { action: 'STATUS', id: String(req.params.id), input }, async (db, actor) => {
    const { item, pool } = await itemAccess(db, actor, String(req.params.id), true);
    if (item.revision !== input.revision) throw new ContentError('REVISION_CONFLICT', 409);
    if (item.lockState !== 'EDITABLE') throw new ContentError('CONTENT_LOCKED', 409);
    if (item.status === input.status) return itemView(item, pool);
    const allowed: Record<string, string[]> = { DRAFT: ['READY', 'ARCHIVED', 'TRASHED'], READY: ['DRAFT', 'DISABLED', 'ARCHIVED'], DISABLED: ['DRAFT', 'READY', 'ARCHIVED', 'TRASHED'], ARCHIVED: ['DRAFT', 'TRASHED'], TRASHED: ['DRAFT'] };
    if (!allowed[item.status]?.includes(input.status)) throw new ContentError('INVALID_CONTENT_TRANSITION', 409);
    if (input.status === 'READY') {
      const validation = validateContentPayload(item.gameSlug, JSON.parse(item.payloadJson));
      if (!validation.success) throw new ContentError('CONTENT_NOT_READY', 400, validation.error.issues);
      if (['PUBLIC', 'SYSTEM'].includes(pool.scope) && (!item.source || !item.license || item.reviewState !== 'APPROVED')) throw new ContentError('PUBLIC_APPROVAL_REQUIRED', 403);
      await validateTagIds(db, itemView(item, pool).effective.tagIds);
    }
    let status = input.status;
    if (status === 'TRASHED' && await db.contentUse.count({ where: { itemId: item.id } })) status = 'ARCHIVED';
    const updated = await db.contentItem.update({ where: { id: item.id, revision: input.revision }, data: { status, revision: { increment: 1 } } });
    await saveRevision(db, updated, actor, 'STATUS', ['status']); return itemView(updated, pool);
  }); res.json({ success: true, data });
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
  res.json({ success: true, data: visible });
}));
contentRouter.get('/tags', endpoint(async (req, res) => {
  await contentActor(prisma, session(req)); res.json({ success: true, data: await prisma.contentTag.findMany({ orderBy: { name: 'asc' } }) });
}));
contentRouter.post('/tags', endpoint(async (req, res) => {
  const input = command.extend({ name: z.string().trim().min(1).max(80), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80) }).strict().parse(req.body);
  const data = await mutateContent(session(req), input.commandId, { action: 'TAG_CREATE', input }, async (db, actor) => {
    const existing = await db.contentTag.findUnique({ where: { slug: input.slug } }); if (existing) return existing;
    const tag = await db.contentTag.create({ data: { name: input.name, slug: input.slug } }); await auditContent(db, actor, 'CONTENT_TAG_CREATE', tag.id, {}); return tag;
  }); res.status(201).json({ success: true, data });
}));
