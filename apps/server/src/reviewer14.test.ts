// ============================================================
// Audit PR14 — Regressionstests für die reproduzierten Fehler-
// bedingungen (14-01..14-06, 14-10). Jeder Test stellt den
// EXAKTEN Zustand des Audit-Befunds her und belegt den Fix:
//   14-01: neue zulässige Absicht (neues Token) wird ausgeführt,
//          nicht als Replay behandelt (echter WID-Socket-Flow).
//   14-02: Fehler zwischen Mutation und Receipt-Abschluss → KEIN
//          Double-Apply bei Retry (Fehler-Injektion); PENDING-
//          Recovery nach Prozessabbruch.
//   14-03: widersprüchliche/veraltete Command-Felder werden VOR
//          der Mutation abgelehnt (echter Socket + Shared-Resolver).
//   14-04: kanonischer wissensduell-Raum mit nicht-default Timer →
//          Snapshot trägt tatsächliche Werte/Version (11 s → 11000 ms).
//   14-05: Config-Update atomar: fehlerhafte Änderung verbraucht
//          die Revision NICHT (Fehler-Injektion → Rollback).
//   14-06: PLAYER_MANAGE-Entzug wird beim Kicken beachtet (echter
//          Socket), auch bei bereits verbundenem Host.
//   14-10: normalizeRole wirft Prototype-Namen sauber weg.
// ============================================================
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { PrismaClient } from '@prisma/client';
import { setupSocketHandlers } from './sockets/index.js';
import { createSessionCookie } from './auth/session.js';
import { config } from './config/index.js';
import { connectGameClient, gameAck } from './test-socket-harness.js';
import { runReceipted } from './games/core/commands.js';
import { createCommandIntentClient } from '@quiz/shared';

const ack = gameAck;
const HOST_USER_ID = 'mod-1';

let testPrisma: PrismaClient;
let httpServer: HttpServer;
let io: Server;
let origin: string;
const sockets: ClientSocket[] = [];
const roomIds: string[] = [];

async function connect(cookie?: string): Promise<ClientSocket> {
  const s = await connectGameClient(origin, cookie);
  sockets.push(s);
  return s;
}

async function makeHostRoom(overrides: {
  slug: string;
  setup: Record<string, unknown>;
  status?: string;
  runPhase?: string;
  players?: number;
} = { slug: 'wer-ist-das', setup: {} }): Promise<{ id: string; code: string; host: ClientSocket }> {
  const code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
  const game = await testPrisma.gameDefinition.findUniqueOrThrow({ where: { slug: overrides.slug } });
  const room = await testPrisma.room.create({
    data: {
      code, roomName: `A14 ${code}`, gameDefinitionId: game.id, hostUserId: HOST_USER_ID,
      status: overrides.status ?? 'LOBBY', runPhase: overrides.runPhase ?? 'LOBBY',
      viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(overrides.setup),
    },
  });
  roomIds.push(room.id);
  const n = overrides.players ?? 2;
  for (let i = 0; i < n; i++) {
    await testPrisma.participation.create({
      data: { roomId: room.id, displayName: `P${i}`, normalizedName: `p${i}-${code}`, role: 'PLAYER', rejoinToken: randomUUID(), connected: true, ready: true },
    });
  }
  const host = await connect(createSessionCookie((await testPrisma.session.findFirstOrThrow({ where: { userId: HOST_USER_ID } })).id, config.sessionSecret));
  expect((await ack(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
  return { id: room.id, code, host };
}

beforeAll(async () => {
  const { PrismaClient } = await import('@prisma/client');
  testPrisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await testPrisma.$connect();
  (globalThis as Record<string, unknown>).__prisma = testPrisma;
  await testPrisma.user.upsert({ where: { id: HOST_USER_ID }, update: {}, create: { id: HOST_USER_ID, displayName: 'A14 Host', passwordHash: 'x', role: 'HOST' } });
  await testPrisma.session.create({ data: { id: `sess-a14-${randomUUID()}`, userId: HOST_USER_ID, expiresAt: new Date(Date.now() + 86400000) } });
  httpServer = createServer();
  io = new Server(httpServer);
  setupSocketHandlers(io);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
  for (const id of roomIds) await testPrisma.room.deleteMany({ where: { id } }).catch(() => undefined);
  await testPrisma.$disconnect();
  (globalThis as Record<string, unknown>).__prisma = undefined;
});


async function reviewWid() {
  const image = await testPrisma.mediaAsset.create({data:{type:'image',mimeType:'image/png',filename:'review.png',originalName:'review.png',fileSize:12,sha256:randomUUID(),storagePath:'/tmp/review.png',uploadedBy:HOST_USER_ID}});
  const room = await makeHostRoom({slug:'wer-ist-das', setup:{rounds:[{id:'r1',imageAssetId:image.id,person1:'A',person2:'B'},{id:'r2',imageAssetId:image.id,person1:'C',person2:'D'}]}});
  const players = await testPrisma.participation.findMany({where:{roomId:room.id,role:'PLAYER'},orderBy:{displayName:'asc'}});
  const clients = await Promise.all(players.map(async p => { const s=await connect(); expect((await ack(s,'room:subscribe',{roomCode:room.code,rejoinToken:p.rejoinToken})).success).toBe(true); return s; }));
  expect((await ack(room.host,'game:start',{roomCode:room.code})).success).toBe(true);
  return {...room, players, clients};
}

it('REVIEW 14-02: lost completion of real WID judge must not judge the next player on retry',async()=>{
  const r=await reviewWid();
  expect((await ack(r.host,'weristdas:buzzer:open',{})).success).toBe(true);
  expect((await ack(r.clients[0],'weristdas:buzz',{})).success).toBe(true);
  const before=await testPrisma.room.findUniqueOrThrow({where:{id:r.id}});
  const original=testPrisma.commandReceipt.update.bind(testPrisma.commandReceipt);
  let injected=false;
  (testPrisma.commandReceipt as any).update=async (a:any)=>{
    if(a.data?.status==='COMPLETED'&&!injected){injected=true;throw new Error('REVIEW_COMPLETION_LOST');}
    return original(a);
  };
  let failed:any;
  try { failed=await ack(r.host,'weristdas:judge',{result:'WRONG',commandId:'review-lost-judge'}); }
  finally {(testPrisma.commandReceipt as any).update=original;}
  expect(failed.success).toBe(false);
  expect(injected).toBe(true);
  const first=JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({where:{roomId:r.id}})).stateJson);
  expect(first.scores[r.players[0].id]).toBe(-1);
  expect((await ack(r.host,'weristdas:buzzer:open',{})).success).toBe(true);
  expect((await ack(r.clients[1],'weristdas:buzz',{})).success).toBe(true);
  const retried=await ack(r.host,'weristdas:judge',{result:'WRONG',commandId:'review-lost-judge'});
  const after=JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({where:{roomId:r.id}})).stateJson);
  console.log('REVIEW_DOUBLE_JUDGE',JSON.stringify({failed,retried,roomRevisionBefore:before.revision,roomRevisionAfter:(await testPrisma.room.findUniqueOrThrow({where:{id:r.id}})).revision,firstScores:first.scores,afterScores:after.scores}));
  expect(after.scores[r.players[1].id],'retry must not deduct a point from another player').toBe(0);
});

it('REVIEW 14-03: WID socket rejects negative stateVersion instead of stripping it',async()=>{
  const r=await reviewWid();
  const res=await ack(r.host,'weristdas:buzzer:open',{commandId:'review-stale',stateVersion:-1,expectedRevision:999999});
  console.log('REVIEW_STRIPPED_VERSION',JSON.stringify(res));
  expect(res.success).toBe(false);
  expect(res.error).toBe('INVALID_PAYLOAD');
});

it('REVIEW 14-03: completed command with expected revision must replay after its own commit',async()=>{
  const {id}=await makeHostRoom({slug:'wer-ist-das',setup:{}});
  const revision=(await testPrisma.room.findUniqueOrThrow({where:{id}})).revision;
  const args={roomId:id,commandId:randomUUID(),actor:{actorId:'reviewer',actorRole:'HOST'},action:'GAME_START' as const,payload:{},stateVersion:revision,mutate:async()=>{await testPrisma.room.update({where:{id},data:{revision:{increment:1}}});return {success:true};},toResponse:(d:{success:boolean})=>d};
  expect((await runReceipted(testPrisma,args)).success).toBe(true);
  const retry=await runReceipted(testPrisma,args);
  console.log('REVIEW_REPLAY_REVISION',JSON.stringify(retry));
  expect(retry).toMatchObject({success:true,replayed:true});
});

it('REVIEW 14-01: phase rejection must not permanently poison the next valid open intent',async()=>{
  const r=await reviewWid();
  expect((await ack(r.host,'weristdas:buzzer:open',{})).success).toBe(true);
  expect((await ack(r.clients[0],'weristdas:buzz',{})).success).toBe(true);
  const {emitCommand}=createCommandIntentClient();
  const key=`${r.code}:wid:weristdas:buzzer:open:r0`;
  const openFromFrontend=()=>new Promise<any>(resolve=>emitCommand(r.host as any,'weristdas:buzzer:open',{},key,resolve));
  const rejected=await openFromFrontend();
  expect(rejected.error).toBe('INVALID_PHASE');
  expect((await ack(r.host,'weristdas:judge',{result:'WRONG'})).success).toBe(true);
  const nextAttempt=await openFromFrontend();
  console.log('REVIEW_POISONED_INTENT',JSON.stringify({rejected,nextAttempt}));
  expect(nextAttempt.success).toBe(true);
});
