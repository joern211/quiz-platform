import { mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../test-helpers.js';
import { singleConnectionSqliteUrl } from './sqliteUrl.js';

describe('singleConnectionSqliteUrl', () => {
  it('adds a single-connection pool to SQLite file URLs', () => {
    expect(singleConnectionSqliteUrl('file:./storage/database/quiz.db')).toBe('file:./storage/database/quiz.db?connection_limit=1');
    expect(singleConnectionSqliteUrl('file:/app/storage/database/quiz.db')).toBe('file:/app/storage/database/quiz.db?connection_limit=1');
  });

  it('keeps other URL parameters and appends with &', () => {
    expect(singleConnectionSqliteUrl('file:./quiz.db?socket_timeout=10')).toBe('file:./quiz.db?socket_timeout=10&connection_limit=1');
  });

  it('never overrides an explicit connection limit chosen by the operator', () => {
    for (const url of ['file:./quiz.db?connection_limit=4', 'file:./quiz.db?socket_timeout=10&connection_limit=4', 'file:./quiz.db?connection_limit=1&socket_timeout=10']) {
      expect(singleConnectionSqliteUrl(url)).toBe(url);
    }
  });

  it('does not mistake a path that merely contains the word for the parameter, and leaves non-SQLite URLs alone', () => {
    expect(singleConnectionSqliteUrl('file:/data/connection_limit=3/quiz.db')).toBe('file:/data/connection_limit=3/quiz.db?connection_limit=1');
    expect(singleConnectionSqliteUrl('postgresql://u:p@host/db')).toBe('postgresql://u:p@host/db');
  });
});

// Regression for the CI failure of g4Restart "Limits": a burst of receipted actions issues concurrent autocommit writes
// (command receipts) while the engine's interactive transaction holds SQLite's write lock. With the default pool the
// writers block every engine worker thread in SQLite's busy handler, so the transaction's own next statement only
// continues after the 5 s busy timeout (P1008 for the writers, P2028 for the transaction).
describe('write burst against an open interactive transaction', () => {
  let dir: string, url: string, db: PrismaClient, roomId: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'quiz-sqlite-url-')); url = `file:${join(dir, 'test.db')}`;
    await createTestDatabase(url);
    db = new PrismaClient({ datasourceUrl: singleConnectionSqliteUrl(url) });
    const user = await db.user.create({ data: { displayName: 'Burst host', role: 'HOST', passwordHash: 'unused' } });
    const definition = await db.gameDefinition.create({ data: { slug: 'wissensduell', name: 'burst', category: 'test', status: 'BETA', minPlayers: 2 } });
    roomId = (await db.room.create({ data: { code: '777-001', roomName: 'Burst', hostUserId: user.id, gameDefinitionId: definition.id, status: 'RUNNING', runPhase: 'OPEN', viewerRequiresPin: false, setupSnapshotJson: '{}' } })).id;
  });
  afterAll(async () => { await db?.$disconnect(); if (dir) await rm(dir, { recursive: true, force: true }); });

  it('lets the transaction and every concurrent receipt write finish promptly (more writers than worker threads)', async () => {
    const writers = Math.max(12, availableParallelism() * 3);
    const started = Date.now();
    const transaction = db.$transaction(async tx => {
      await tx.room.findUniqueOrThrow({ where: { id: roomId } });
      await tx.room.update({ where: { id: roomId }, data: { revision: { increment: 1 } } });
      await new Promise(resolve => setTimeout(resolve, 30)); // the handler's own work between statements
      await tx.room.update({ where: { id: roomId }, data: { revision: { increment: 1 } } });
    });
    const receipts = Array.from({ length: writers }, (_, i) => db.commandReceipt.create({
      data: { roomId, commandId: randomUUID(), actorId: `actor-${i}`, actorRole: 'PLAYER', action: 'ANSWER_SUBMIT', payloadHash: 'h', status: 'PENDING' },
    }));
    const settled = await Promise.allSettled([transaction, ...receipts]);
    expect(settled.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason?.code)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000); // the stall lasts the 5 s busy timeout, so this cannot pass by accident
    expect(await db.commandReceipt.count({ where: { roomId } })).toBe(writers);
    expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).revision).toBe(2);
  }, 30000);
});
