// TEST-ONLY backend for the N7 audio harness. It binds the REAL server helpers (audioPlaybackPlan.ts, normalizeAudio) to a tiny HTTP
// API so that two real Chromium contexts can play the same server plan. It is not a product endpoint, has no auth and lives outside
// src/: it is never part of a build. Media is served at a harness stand-in path (the product's protected media route, signature and
// content authorisation are covered by media.integration.test.ts / audio.integration.test.ts and are NOT exercised here).
// Run: node --import tsx apps/web/harness/n7-audio/server.ts [port]
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAudio } from '../../../server/src/media/audio.js';
import {
  createAudioPlayback, createRenewalIssuer, pauseAudioPlayback, projectAudioPlayback, readAudioPlayback, resumeAudioPlayback, settleAudioPlayback, startAudioPlayback,
  stopAudioPlayback, type AudioPlaybackState,
} from '../../../server/src/games/core/audioPlaybackPlan.js';
import type { ProjectionAudience, VisibilityRule } from '../../../server/src/games/core/visibility.js';

const port = Number(process.argv[2] ?? 5196);

/** Deterministic mono sine WAV: the same frequency and length always give the same bytes (no random source). */
function sineWav(freq: number, seconds: number): Buffer {
  const rate = 22050, n = Math.round(rate * seconds), data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return data;
}
const clips: Record<string, { mp3: Buffer; durationMs: number; freq: number }> = {};
async function prepare(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'n7-harness-'));
  for (const [id, freq, seconds] of [['clip-a', 440, 12], ['clip-b', 660, 12], ['clip-short', 440, 8]] as const) {
    const file = join(dir, `${id}.wav`);
    writeFileSync(file, sineWav(freq, seconds));
    const out = await normalizeAudio(file, 'wav'); // the REAL pipeline: decode, loudness, metadata-free MP3; `duration` is the trusted length
    clips[id] = { mp3: out.buffer, durationMs: out.duration, freq };
  }
  // TEST-ONLY mismatch: the file really lasts 8 s but the plan claims the 12 s of the other clips — a media end BEFORE the authoritative end.
  clips['clip-short'].durationMs = clips['clip-a'].durationMs;
}

// ── harness state (one playback instance at a time) ──
let counter = 0;
let state: AudioPlaybackState;
let clipId = 'clip-a';
let stateVersion = 1;
let urlToken = 1;
let issueRenewal = createRenewalIssuer();
let renewal = issueRenewal(Date.now());
let broken = false;
let mediaMode: 'normal' | 'slow' = 'normal';
let visibility: VisibilityRule = { scope: 'PUBLIC' };
const releases: Record<string, 'NONE' | 'LOAD_ONLY' | 'PLAY'> = {};
const resolverCalls: Record<string, number> = {};
const scopeOf = () => state.scope;
function reset(clip = 'clip-a'): void {
  counter++; clipId = clip; stateVersion++; urlToken = 1; issueRenewal = createRenewalIssuer(); renewal = issueRenewal(Date.now()); broken = false; mediaMode = 'normal'; visibility = { scope: 'PUBLIC' };
  for (const k of Object.keys(releases)) delete releases[k];
  for (const k of Object.keys(resolverCalls)) delete resolverCalls[k];
  state = createAudioPlayback({ scope: { runIndex: 1, roundId: 'harness-round', playbackId: `pb-${counter}`, contentRevision: 'rev-1' }, assetId: clip, durationMs: clips[clip].durationMs, now: Date.now() });
}
const AUDIENCES: Record<string, ProjectionAudience> = {
  PLAYER: { role: 'PLAYER', participantId: 'p1' }, VIEWER: { role: 'VIEWER' }, DISPLAY: { role: 'DISPLAY' }, HOST: { role: 'HOST' }, BLIND_HOST: { role: 'HOST', blindHost: true },
};

function command(body: { type: string; leadMs?: number; role?: string; release?: 'NONE' | 'LOAD_ONLY' | 'PLAY'; clip?: string; scope?: 'PUBLIC' | 'HOST_PRIVATE'; mode?: 'normal' | 'slow' }): object {
  const now = Date.now(), base = { scope: scopeOf(), expectedVersion: state.version, now };
  const startAtMs = now + (body.leadMs ?? 0);
  let changed = false;
  switch (body.type) {
    case 'reset': reset(body.clip ?? 'clip-a'); return { ok: true };
    case 'start': ({ state, changed } = startAudioPlayback(state, { ...base, startAtMs })); break;
    case 'pause': ({ state, changed } = pauseAudioPlayback(state, base)); break;
    case 'resume': ({ state, changed } = resumeAudioPlayback(state, { ...base, startAtMs })); break;
    case 'stop': ({ state, changed } = stopAudioPlayback(state, base)); break;
    case 'settle': ({ state, changed } = settleAudioPlayback(state, base)); break;
    case 'release': releases[body.role!] = body.release!; stateVersion++; return { ok: true };
    case 'visibility': visibility = { scope: body.scope! }; stateVersion++; return { ok: true };
    case 'renew': urlToken++; renewal = issueRenewal(Date.now()); broken = false; return { ok: true, urlToken, renewal };
    case 'break': broken = true; return { ok: true };
    case 'media': mediaMode = body.mode ?? 'normal'; return { ok: true };
    default: throw new Error('unknown command');
  }
  if (changed) stateVersion++;
  return { ok: true, changed, state, reading: readAudioPlayback(state, Date.now()) };
}

function range(req: http.IncomingMessage, size: number): { start: number; end: number; partial: boolean } {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m) return { start: 0, end: size - 1, partial: false };
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] !== '' && m[2] !== '' ? Math.min(size - 1, Number(m[2])) : size - 1;
  return { start, end, partial: true };
}

const send = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req: http.IncomingMessage) => new Promise<string>(resolve => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); });

prepare().then(() => {
  reset();
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/api/time') return send(res, 200, { serverMs: Date.now() });
      if (url.pathname === '/api/context') return send(res, 200, { scope: scopeOf(), minStateVersion: 0 });
      if (url.pathname === '/api/stats') return send(res, 200, { resolverCalls, clips: Object.fromEntries(Object.entries(clips).map(([k, v]) => [k, { durationMs: v.durationMs, freq: v.freq, bytes: v.mp3.length }])), clipId, state, stateVersion, urlToken, renewal });
      if (url.pathname === '/api/projection') {
        const role = url.searchParams.get('role') ?? 'VIEWER';
        const projection = projectAudioPlayback(AUDIENCES[role], state, {
          release: releases[role] ?? 'PLAY', sourceVisibility: visibility, stateVersion, now: Date.now(),
          resolveSource: assetId => { resolverCalls[role] = (resolverCalls[role] ?? 0) + 1; return { url: `/harness-media/${assetId}.mp3?tok=${urlToken}`, renewal }; },
        });
        return send(res, 200, projection);
      }
      if (url.pathname === '/api/cmd' && req.method === 'POST') return send(res, 200, command(JSON.parse(await readBody(req))));
      const media = /^\/harness-media\/(clip-(?:a|b|short))\.mp3$/.exec(url.pathname);
      if (media) {
        if (broken) { res.writeHead(404); return res.end(); }
        if (mediaMode === 'slow') {
          // TEST-ONLY: no Range support and a throttled body (about 4x real time), so the first seconds of the clip are NOT yet seekable for a late joiner.
          const whole = clips[media[1]].mp3;
          res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': whole.length, 'accept-ranges': 'none', 'cache-control': 'no-store' });
          let offset = 0;
          const timer = setInterval(() => { if (offset >= whole.length || res.destroyed) { clearInterval(timer); res.end(); return; } res.write(whole.subarray(offset, offset + 16_384)); offset += 16_384; }, 250);
          res.on('close', () => clearInterval(timer));
          return;
        }
        const buf = clips[media[1]].mp3, r = range(req, buf.length);
        res.writeHead(r.partial ? 206 : 200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': r.end - r.start + 1, 'cache-control': 'no-store',
          ...(r.partial ? { 'content-range': `bytes ${r.start}-${r.end}/${buf.length}` } : {}) });
        return res.end(buf.subarray(r.start, r.end + 1));
      }
      res.writeHead(404); res.end();
    } catch (error) { send(res, 400, { error: String((error as Error).message) }); }
  // eslint-disable-next-line no-console -- test-only harness: the check script waits for this port
  }).listen(port, '127.0.0.1', () => console.log(`n7 harness backend on ${port}`));
});
