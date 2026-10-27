import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../persistence/prisma.js';
import { ContentError, type ContentDb } from './core.js';
import { notifyContent } from './review.js';

export const CorrectionAccessSchema = z.object({ roomCode: z.string().regex(/^\d{3}-\d{3}$/), participantId: z.string().min(1).max(128),
  rejoinToken: z.string().min(16).max(256), runIndex: z.number().int().positive().optional() });
export const CorrectionSubmitSchema = CorrectionAccessSchema.extend({ commandId: z.string().uuid(), itemId: z.string().min(1).max(128),
  field: z.enum(['prompt', 'question', 'answer', 'correctOptionId', 'explanation', 'category']), currentValue: z.string().max(10000),
  proposedValue: z.string().trim().min(1).max(10000), comment: z.string().max(2000).default('') }).strict();

async function correctionParticipant(db: ContentDb, input: z.infer<typeof CorrectionAccessSchema>) {
  const room = await db.room.findUnique({ where: { code: input.roomCode } });
  if (!room || ['CLOSED', 'EXPIRED'].includes(room.lifecycle ?? '') || room.expiresAt && room.expiresAt <= new Date()) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
  const participant = await db.participation.findFirst({ where: { id: input.participantId, roomId: room.id, role: 'PLAYER', rejoinToken: input.rejoinToken,
    kickedAt: null, bannedAt: null, leftAt: null, admission: 'ACTIVE' } });
  if (!participant) throw new ContentError('NOT_AUTHENTICATED', 401);
  return { room, participant };
}
export async function eligibleCorrectionContent(db: ContentDb, input: z.infer<typeof CorrectionAccessSchema>) {
  const { room } = await correctionParticipant(db, input), runIndex = input.runIndex ?? room.runIndex;
  const results = await db.roundResultRecord.findMany({ where: { roomId: room.id, runIndex } });
  const revealedIds = new Set<string>();
  for (const row of results) {
    const parsed = z.object({ publicContentIds: z.array(z.string()), aborted: z.boolean(), skipped: z.boolean() }).safeParse(JSON.parse(row.dataJson));
    if (parsed.success && !parsed.data.aborted && !parsed.data.skipped) for (const id of parsed.data.publicContentIds) revealedIds.add(id);
  }
  const uses = await db.contentUse.findMany({ where: { roomId: room.id, runIndex, itemId: { in: [...revealedIds] } }, orderBy: { position: 'asc' } });
  return uses.map(row => {
    const stored = z.object({ id: z.string(), revision: z.number().int(), payload: z.record(z.unknown()) }).parse(JSON.parse(row.snapshotJson));
    return { itemId: stored.id, revision: stored.revision, runIndex, payload: stored.payload };
  });
}
export async function submitContentCorrection(input: z.infer<typeof CorrectionSubmitSchema>) {
  return prisma.$transaction(async db => {
    const { room, participant } = await correctionParticipant(db, input);
    await db.$executeRaw`UPDATE rooms SET revision = revision WHERE id = ${room.id}`;
    // Recheck identity after obtaining the database write reservation.
    await correctionParticipant(db, input);
    const actorId = `participant:${participant.id}`, intent = { itemId: input.itemId, field: input.field, currentValue: input.currentValue, proposedValue: input.proposedValue,
      comment: input.comment, runIndex: input.runIndex ?? room.runIndex }, intentHash = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
    const receipt = await db.contentMutationReceipt.findUnique({ where: { actorId_commandId: { actorId, commandId: input.commandId } } });
    if (receipt) { if (receipt.intentHash !== intentHash) throw new ContentError('COMMAND_CONFLICT', 409); return JSON.parse(receipt.responseJson) as { reviewId: string }; }
    const available = await eligibleCorrectionContent(db, input), content = available.find(q => q.itemId === input.itemId);
    if (!content || typeof content.payload[input.field] !== 'string' || content.payload[input.field] !== input.currentValue) throw new ContentError('CONTENT_NOT_REVEALED', 403);
    const item = await db.contentItem.findUniqueOrThrow({ where: { id: input.itemId }, include: { pool: true } });
    const review = await db.contentReview.create({ data: { poolId: item.poolId, itemId: item.id, actorId, baseRevision: content.revision,
      kind: 'CORRECTION', proposedJson: JSON.stringify({ ...intent, participantId: participant.id }) } });
    await notifyContent(db, item.pool.ownerId, item.poolId, 'CORRECTION_PROPOSAL', 'Neuer Korrekturvorschlag aus einer gespielten Runde.', item.id);
    await db.auditLog.create({ data: { action: 'CONTENT_CORRECTION_SUBMIT', resource: 'CONTENT', resourceId: item.id,
      metadata: JSON.stringify({ reviewId: review.id, participantId: participant.id, revision: content.revision }) } });
    const result = { reviewId: review.id };
    await db.contentMutationReceipt.create({ data: { actorId, commandId: input.commandId, intentHash, responseJson: JSON.stringify(result) } });
    return result;
  });
}
