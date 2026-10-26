import { activeBlindHost } from './blindHost.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';
import type { ContentItem } from '@prisma/client';
import { z } from 'zod';
import { ContentMediaRightsSchema } from '@quiz/shared';
import { hasPlaytestAuthority } from './playtestAccess.js';
import { config } from '../config/index.js';
import { ContentError, canReadPool, contentActor, type ContentActor, type ContentDb } from './core.js';

const contextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PLAYTEST'), code: z.string().min(20).max(64), itemId: z.string().min(1).max(128), revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('EDITOR'), itemId: z.string().min(1).max(128), revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('ROOM'), roomId: z.string().min(1).max(128), runIndex: z.number().int().positive(), itemId: z.string().min(1).max(128) }).strict(),
]);
type Context = z.infer<typeof contextSchema>;
const sign = (assetId: string, ctx: string, exp: number) => createHmac('sha256', config.sessionSecret).update(`${assetId}|content|${ctx}|${exp}`).digest('base64url');
export function contentMediaUrl(assetId: string, context: Context) {
  const ctx = Buffer.from(JSON.stringify(contextSchema.parse(context))).toString('base64url'), exp = Math.floor(Date.now() / 1000) + 300;
  return `/api/v1/media/${encodeURIComponent(assetId)}?ctx=${ctx}&exp=${exp}&sig=${sign(assetId, ctx, exp)}`;
}
export function roomContentMediaUrl(roomId: string, runIndex: number | undefined, itemId: string | undefined, assetId: string | undefined) {
  return runIndex && itemId && assetId ? contentMediaUrl(assetId, { kind: 'ROOM', roomId, runIndex, itemId }) : undefined;
}
/** A draft may be incomplete; a concrete private reference may never be smuggled into an accessible pool. */
export async function validateContentMedia(db: ContentDb, actor: ContentActor, payload: Record<string, unknown>, ready = false, publicPool = false) {
  const id = payload.mediaAssetId;
  if (id === undefined && payload.mediaType === undefined) return;
  if (typeof id !== 'string' || !id) { if (ready) throw new ContentError('MEDIA_NOT_READY'); return; }
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw new ContentError('MEDIA_NOT_ACCESSIBLE');
  let allowed = actor.role === 'ADMIN' || asset.uploadedBy === actor.userId || ['PUBLIC', 'SYSTEM'].includes(asset.visibility);
  if (!allowed) {
    const refs = await db.contentMediaReference.findMany({ where: { assetId: id }, include: { item: { include: { pool: true } } } });
    allowed = refs.some(({ item: ref }) => ref.status !== 'TRASHED' && JSON.parse(ref.payloadJson).mediaAssetId === id && canReadPool(ref.pool, actor)
      && (!['PUBLIC', 'SYSTEM'].includes(ref.pool.scope) || ref.pool.ownerId === actor.userId || ref.status === 'READY' && ref.reviewState === 'APPROVED'));
  }
  if (!allowed) throw new ContentError('MEDIA_NOT_ACCESSIBLE');
  if (ready) await validateReadyMedia(db, payload, publicPool);
}
export async function validateReadyMedia(db: ContentDb, payload: Record<string, unknown>, publicPool = false) {
  if (payload.mediaAssetId === undefined && payload.mediaType === undefined) return;
  if (typeof payload.mediaAssetId !== 'string') throw new ContentError('MEDIA_NOT_READY');
  const asset = await db.mediaAsset.findUnique({ where: { id: payload.mediaAssetId } });
  if (!asset || asset.variantKind === 'ORIGINAL' || asset.processStatus !== 'READY' || !['image', 'audio'].includes(asset.type) || asset.type !== payload.mediaType) throw new ContentError('MEDIA_NOT_READY');
  try { await access(asset.storagePath); } catch { throw new ContentError('MEDIA_NOT_READY'); }
  const rights = ContentMediaRightsSchema.safeParse(payload.mediaRights);
  if (!rights.success || (!rights.data.ownMaterial && ((!rights.data.source.trim() && !rights.data.sourceUrl.trim()) || !rights.data.license.trim()))
    || rights.data.recognizablePerson && !rights.data.consent
    || publicPool && (!rights.data.license.trim() || !rights.data.source.trim() && !rights.data.sourceUrl.trim() && !rights.data.ownMaterial)) throw new ContentError('MEDIA_RIGHTS_REQUIRED');
}
export async function pinnedContentMediaReady(db: ContentDb, roomId: string, runIndex: number) {
  const uses = await db.contentUse.findMany({ where: { roomId, runIndex } });
  try {
    for (const use of uses) {
      const payload = JSON.parse(use.snapshotJson).payload as Record<string, unknown>;
      if (typeof payload.mediaAssetId === 'string' && !await db.contentMediaReference.count({ where: { itemId: use.itemId, itemRevision: use.itemRevision, assetId: payload.mediaAssetId } })) return false;
      await validateReadyMedia(db, payload);
    }
    return true;
  } catch (e) { if (e instanceof ContentError) return false; throw e; }
}

/** Signatures bind an immutable asset to its authorized content and run, never merely to an ID. */
export async function canDeliverContentMedia(db: ContentDb, assetId: string, query: { ctx?: string; exp?: string; sig?: string }, sessionId: string | null) {
  const { ctx, exp, sig } = query; if (!ctx || ctx.length > 2048 || !exp || !sig) return false;
  const expires = Number(exp); if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(sign(assetId, ctx, expires)), given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  let context: Context;
  try { context = contextSchema.parse(JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))); } catch { return false; }
  if (context.kind === 'PLAYTEST') {
    const test = await db.contentPlaytest.findUnique({ where: { code: context.code } });
    if (!test || test.expiresAt <= new Date() || test.phase === 'CLOSED' || !await hasPlaytestAuthority(db, test)) return false;
    const snapshot = JSON.parse(test.snapshotJson)[test.position];
    return snapshot?.id === context.itemId && snapshot.revision === context.revision && snapshot.payload?.mediaAssetId === assetId
      && await db.contentMediaReference.count({ where: { itemId: context.itemId, itemRevision: context.revision, assetId } }) > 0;
  }
  if (context.kind === 'EDITOR') {
    let actor: ContentActor; try { actor = await contentActor(db, sessionId); } catch { return false; }
    if (await activeBlindHost(db, actor.userId)) return false;
    const item = await db.contentItem.findUnique({ where: { id: context.itemId }, include: { pool: true } });
    if (!item || item.revision !== context.revision || !canReadPool(item.pool, actor) || JSON.parse(item.payloadJson).mediaAssetId !== assetId) return false;
    if (!await db.contentMediaReference.count({ where: { itemId: item.id, assetId } })) return false;
    return !['PUBLIC', 'SYSTEM'].includes(item.pool.scope) || item.pool.ownerId === actor.userId || actor.role === 'ADMIN' || item.status === 'READY' && item.reviewState === 'APPROVED';
  }
  const room = await db.room.findUnique({ where: { id: context.roomId }, include: { gameDefinition: true, gameState: true } });
  if (!room || room.runIndex !== context.runIndex || room.status === 'ARCHIVED' || ['CLOSED', 'EXPIRED'].includes(room.lifecycle ?? '')
    || room.expiresAt && room.expiresAt <= new Date() || !room.gameState) return false;
  const use = await db.contentUse.findUnique({ where: { roomId_runIndex_itemId: { roomId: room.id, runIndex: context.runIndex, itemId: context.itemId } } });
  if (!use || JSON.parse(use.snapshotJson).payload?.mediaAssetId !== assetId) return false;
  const state = JSON.parse(room.gameState.stateJson);
  if (['GAME_END', 'ERROR_RECOVERY', 'INTRO', 'ROUND_READY', 'SELECTING'].includes(state.phase)) return false;
  if (room.gameDefinition.slug === 'wissensduell') return state.roundStates?.[state.currentRoundIndex]?.question?.id === context.itemId;
  if (room.gameDefinition.slug === 'jeopardy' && state.currentField) {
    const setup = JSON.parse(room.setupSnapshotJson ?? '{}'), board = state.currentBoard === 1 ? setup.board1 : setup.board2;
    const clue = board?.categories?.[state.currentField.categoryIndex]?.clues?.find((c: { value: number }) => c.value === state.currentField.value);
    return clue?.contentId === context.itemId;
  }
  return false;
}

export async function recordContentMediaReference(db: ContentDb, actor: ContentActor, item: ContentItem) {
  const payload = JSON.parse(item.payloadJson); if (typeof payload.mediaAssetId !== 'string' || !payload.mediaAssetId) return;
  await validateContentMedia(db, actor, payload);
  await db.contentMediaReference.create({ data: { itemId: item.id, itemRevision: item.revision, assetId: payload.mediaAssetId, authorizedBy: actor.userId } });
}
