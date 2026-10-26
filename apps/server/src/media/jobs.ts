import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { processUploaded } from './process.js';
import { AudioProcessingError } from './audio.js';
import { logger } from '../observability/logger.js';
export class MediaJobError extends Error { constructor(readonly code: string) { super(code); } }
export async function queueMediaJob(db: PrismaClient, ownerId: string, commandId: string, file: { path: string; size: number; originalname: string }) {
  const hash = createHash('sha256').update(await fs.readFile(file.path)).digest('hex');
  const existing = await db.mediaProcessingJob.findUnique({ where: { ownerId_commandId: { ownerId, commandId } } });
  if (existing) { await fs.rm(file.path, { force: true }); if (existing.inputHash !== hash) throw new MediaJobError('COMMAND_REUSE_MISMATCH'); return existing; }
  if (await db.mediaProcessingJob.count({ where: { ownerId, status: { in: ['QUEUED', 'PROCESSING'] } } }) >= 10) throw new MediaJobError('MEDIA_QUEUE_FULL');
  const id = randomUUID(), destination = path.join(path.dirname(file.path), 'originals', `${id}.bin`); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(file.path, destination);
  try { return await db.$transaction(async tx => {
    const original = await tx.mediaAsset.create({ data: { type: 'pending', mimeType: 'application/octet-stream', filename: `${id}.bin`, originalName: path.basename(file.originalname).slice(0, 255), fileSize: file.size, sha256: hash, assetKey: `original:${id}`, storagePath: destination, uploadedBy: ownerId, variantKind: 'ORIGINAL', visibility: 'PRIVATE', processStatus: 'PROCESSING' } });
    const job = await tx.mediaProcessingJob.create({ data: { id, ownerId, commandId, inputHash: hash, originalId: original.id } });
    await tx.auditLog.create({ data: { userId: ownerId, action: 'MEDIA_JOB_QUEUED', resource: 'MEDIA', resourceId: original.id } }); return job;
  }); } catch (error) {
    await fs.rm(destination, { force: true }); const raced = await db.mediaProcessingJob.findUnique({ where: { ownerId_commandId: { ownerId, commandId } } });
    if (raced && raced.inputHash === hash) return raced; throw error;
  }
}
export async function runNextMediaJob(db: PrismaClient): Promise<boolean> {
  const now = new Date(), eligible = { OR: [{ status: 'QUEUED' }, { status: 'PROCESSING', leaseUntil: { lt: now } }] };
  const candidate = await db.mediaProcessingJob.findFirst({ where: eligible, orderBy: { createdAt: 'asc' }, include: { original: true } }); if (!candidate) return false;
  const lease = randomUUID();
  const claimed = await db.mediaProcessingJob.updateMany({ where: { id: candidate.id, ...eligible }, data: { status: 'PROCESSING', attempts: { increment: 1 }, leaseToken: lease, leaseUntil: new Date(Date.now() + Math.max(120000, config.audioProcessing.timeoutMs + 30000)), errorCode: null } });
  if (!claimed.count) return true;
  const produced: string[] = [];
  try {
    const processed = await processUploaded(candidate.original.storagePath, candidate.original.fileSize);
    if (!processed.ok || !processed.buffer || !processed.type || !processed.mimeType) throw new AudioProcessingError('MEDIA_REJECTED', 'Ungültiges Medium.');
    const directory = path.join(path.dirname(candidate.original.storagePath), '..', 'variants'); await fs.mkdir(directory, { recursive: true });
    const outputs: { kind: string; buffer: Buffer; mimeType: string; width?: number; height?: number; duration?: number }[] = [{ kind: processed.type === 'audio' ? 'NORMALIZED_AUDIO' : 'WEB', buffer: processed.buffer, mimeType: processed.mimeType, width: processed.width, height: processed.height, duration: processed.duration }];
    if (processed.type === 'image') { const thumb = await sharp(processed.buffer).resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer({ resolveWithObject: true }); outputs.push({ kind: 'THUMBNAIL', buffer: thumb.data, mimeType: 'image/webp', width: thumb.info.width, height: thumb.info.height }); }
    for (const output of outputs) { const target = path.join(directory, `${candidate.id}-${lease}-${output.kind}.${processed.type === 'audio' ? 'mp3' : 'webp'}`); produced.push(target); await fs.writeFile(target, output.buffer, { flag: 'wx' }); }
    await db.$transaction(async tx => {
      const owns = await tx.mediaProcessingJob.updateMany({ where: { id: candidate.id, status: 'PROCESSING', leaseToken: lease }, data: { status: 'COMMITTING' } }); if (!owns.count) throw new MediaJobError('MEDIA_LEASE_LOST');
      let outputId = '';
      for (let i = 0; i < outputs.length; i++) {
        const output = outputs[i], asset = await tx.mediaAsset.create({ data: { type: processed.type!, mimeType: output.mimeType, filename: path.basename(produced[i]), originalName: 'processed-media', fileSize: output.buffer.length, sha256: createHash('sha256').update(output.buffer).digest('hex'), assetKey: `job:${candidate.id}:${output.kind}`, uploadedBy: candidate.ownerId, visibility: 'PRIVATE', storagePath: produced[i], processStatus: 'READY', processed: true, variantKind: output.kind, derivedFromAssetIds: JSON.stringify([candidate.originalId]), width: output.width, height: output.height, duration: output.duration } });
        await tx.mediaAssetVariant.create({ data: { originalId: candidate.originalId, assetId: asset.id, kind: output.kind } }); if (i === 0) outputId = asset.id;
      }
      await tx.mediaAsset.update({ where: { id: candidate.originalId }, data: { processStatus: 'READY', type: processed.type } });
      await tx.mediaProcessingJob.update({ where: { id: candidate.id }, data: { status: 'READY', outputId, leaseToken: null, leaseUntil: null, retryable: false } });
      await tx.auditLog.create({ data: { userId: candidate.ownerId, action: 'MEDIA_JOB_READY', resource: 'MEDIA', resourceId: outputId } });
    });
    // Remove abandoned outputs from earlier crashed leases, never committed assets.
    const protectedPaths = new Set((await db.mediaAsset.findMany({ where: { derivedFromAssetIds: JSON.stringify([candidate.originalId]) }, select: { storagePath: true } })).map(a => a.storagePath));
    for (const name of await fs.readdir(directory)) if (name.startsWith(`${candidate.id}-`)) { const target = path.join(directory, name); if (!protectedPaths.has(target)) await fs.rm(target, { force: true }); }
  } catch (error) {
    // If success committed, its referenced files must survive even if later housekeeping failed.
    const current = await db.mediaProcessingJob.findUnique({ where: { id: candidate.id } });
    if (current?.status === 'READY') return true;
    for (const target of produced) await fs.rm(target, { force: true });
    const code = error instanceof AudioProcessingError || error instanceof MediaJobError ? error.code : 'MEDIA_PROCESSING_FAILED';
    const retryable = error instanceof AudioProcessingError && error.status === 503;
    const status = code === 'MEDIA_REJECTED' ? 'REJECTED' : 'FAILED';
    await db.$transaction(async tx => {
      const owns = await tx.mediaProcessingJob.updateMany({ where: { id: candidate.id, leaseToken: lease }, data: { status, errorCode: code, retryable, leaseToken: null, leaseUntil: null } });
      if (owns.count) { await tx.mediaAsset.update({ where: { id: candidate.originalId }, data: { processStatus: status } }); await tx.auditLog.create({ data: { userId: candidate.ownerId, action: 'MEDIA_JOB_FAILED', resource: 'MEDIA', resourceId: candidate.originalId, metadata: JSON.stringify({ code, status }) } }); }
    });
  }
  return true;
}
export function startMediaWorker(db: PrismaClient) {
  let stopped = false, active: Promise<void> | null = null;
  const tick = () => { if (stopped || active) return; active = (async () => { try { await runNextMediaJob(db); } catch (error) { logger.error('Media worker tick failed', { error }); } })().finally(() => { active = null; }); };
  const timer = setInterval(tick, 500); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}

/** Only stale, unreferenced staging files from this pipeline; never general user storage. */
export async function cleanupMediaJobStaging(db: PrismaClient, now = Date.now()) {
  for (const area of ['originals', 'variants']) {
    const directory = path.resolve(config.storagePaths.uploads, area);
    let names: string[]; try { names = await fs.readdir(directory); } catch { continue; }
    for (const name of names) {
      if (!/^[a-f0-9-]{36}(?:\.bin|-[a-f0-9-]{36}-(?:WEB|THUMBNAIL|NORMALIZED_AUDIO)\.(?:webp|mp3))$/.test(name)) continue;
      const target = path.join(directory, name), stat = await fs.stat(target); if (!stat.isFile() || now - stat.mtimeMs < 86400000) continue;
      if (!await db.mediaAsset.count({ where: { storagePath: target } })) await fs.rm(target, { force: true });
    }
  }
}
