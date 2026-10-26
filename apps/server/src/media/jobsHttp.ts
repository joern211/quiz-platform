import type { Router, Request, RequestHandler } from 'express';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { prisma } from '../persistence/prisma.js';
import { verifySession } from '../auth/session.js';
import { config } from '../config/index.js';
import { assertBlindEditorialAccess } from '../content/blindHost.js';
import { queueMediaJob, MediaJobError } from './jobs.js';
async function owner(req: Request) { const id = verifySession(req, config.sessionSecret); if (!id) throw new MediaJobError('NOT_AUTHENTICATED'); const session = await prisma.session.findFirst({ where: { id, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } } }); if (!session) throw new MediaJobError('NOT_AUTHENTICATED'); await assertBlindEditorialAccess(prisma, id); return session.userId; }
async function jobView(id: string, userId: string) {
  const job = await prisma.mediaProcessingJob.findFirst({ where: { id, ownerId: userId } }); if (!job) throw new MediaJobError('NOT_FOUND');
  const asset = job.outputId && job.status === 'READY' ? await prisma.mediaAsset.findUnique({ where: { id: job.outputId } }) : null;
  const variants = await prisma.mediaAssetVariant.findMany({ where: { originalId: job.originalId }, select: { assetId: true, kind: true } });
  return { variants, id: job.id, status: job.status, originalId: job.originalId, retryable: job.retryable, errorCode: job.errorCode, asset: asset ? { id: asset.id, type: asset.type, mimeType: asset.mimeType, fileSize: asset.fileSize, duration: asset.duration } : null };
}
export function registerMediaJobs(router: Router, receiveUpload: RequestHandler) {
  const auth: RequestHandler = async (req, res, next) => { try { res.locals.mediaOwner = await owner(req); next(); } catch { res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Medienzugriff nicht erlaubt.' } }); } };
  router.post('/jobs', auth, receiveUpload, async (req, res) => {
    const file = req.file;
    try {
      const commandId = z.string().uuid().parse(req.body.commandId); if (!file) throw new MediaJobError('NO_FILE');
      const job = await queueMediaJob(prisma, res.locals.mediaOwner, commandId, file);
      res.status(202).json({ success: true, data: await jobView(job.id, res.locals.mediaOwner) });
    } catch (error) { if (file) await fs.rm(file.path, { force: true }); const code = error instanceof MediaJobError ? error.code : error instanceof z.ZodError ? 'INVALID_PAYLOAD' : 'MEDIA_JOB_FAILED'; res.status(code === 'COMMAND_REUSE_MISMATCH' ? 409 : code === 'MEDIA_QUEUE_FULL' ? 429 : 400).json({ success: false, error: { code, message: 'Upload konnte nicht vorgemerkt werden.' } }); }
  });
  router.get('/jobs/:id', auth, async (req, res) => { try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, data: await jobView(String(req.params.id), res.locals.mediaOwner) }); } catch { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Verarbeitung nicht gefunden.' } }); } });
  router.get('/jobs/:id/original', auth, async (req, res) => {
    const job = await prisma.mediaProcessingJob.findFirst({ where: { id: String(req.params.id), ownerId: res.locals.mediaOwner, status: 'READY' }, include: { original: true } });
    if (!job) return void res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Original nicht gefunden.' } });
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', 'attachment; filename=original-media'); res.sendFile(job.original.storagePath);
  });
  router.post('/jobs/:id/retry', auth, async (req, res) => {
    try {
      const result = await prisma.$transaction(async tx => { const job = await tx.mediaProcessingJob.findFirst({ where: { id: String(req.params.id), ownerId: res.locals.mediaOwner } }); if (!job) throw new MediaJobError('NOT_FOUND');
        if (job.status === 'FAILED' && job.retryable) { await tx.mediaProcessingJob.update({ where: { id: job.id }, data: { status: 'QUEUED', errorCode: null, retryable: false } }); await tx.mediaAsset.update({ where: { id: job.originalId }, data: { processStatus: 'PROCESSING' } }); await tx.auditLog.create({ data: { userId: res.locals.mediaOwner, action: 'MEDIA_JOB_RETRY', resource: 'MEDIA', resourceId: job.originalId } }); }
        return job.id; }); res.json({ success: true, data: await jobView(result, res.locals.mediaOwner) });
    } catch { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Verarbeitung nicht gefunden.' } }); }
  });
}
