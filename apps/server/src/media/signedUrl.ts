// ============================================================
// Signed Media URLs — Kurzlebig, Audience-geschützt (Regelwerk §10.8)
//
// Private/Secrete Assets haben keine permanente, erratbare URL. Jede
// Auslieferung erfolgt über eine HMAC-signierte, zeitlich begrenzte URL:
//   - audience "game" → freigegebenes Spielbild (Composite / v1-Bild),
//                       an Player/Viewer/Display ohne Login.
//   - audience "host" → Originale, NUR zusätzlich mit gültiger Session
//                       eines berechtigten Hosts (uploader == user ODER
//                       user == Host von asset.roomId) — geprüft in media.ts.
//
// Die Signatur bindet assetId + audience + expiry an den Session-Secret,
// ist damit nicht erwerbbar und bei Ablauf/Asset-Tausch ungültig.
// ============================================================

import crypto from 'crypto';
import { config } from '../config/index.js';

export type MediaUrlAudience = 'game' | 'host';

/** Gültigkeitsdauer einer "game"-URL (Sekunden). Kurzlebig nach §10.8. */
export const MEDIA_URL_TTL_SECONDS = 5 * 60;
/** "host"-URLs (Originale) dürfen etwas länger gültig sein. */
export const MEDIA_HOST_URL_TTL_SECONDS = 60 * 60;

export function signMediaAccess(params: {
  assetId: string;
  audience: MediaUrlAudience;
  expiresAtEpochSeconds: number;
}): string {
  const { assetId, audience, expiresAtEpochSeconds } = params;
  const payload = `${assetId}|${audience}|${expiresAtEpochSeconds}`;
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

/** Baut eine gültige, kurzlebige Signed-URL für ein Asset. */
export function buildSignedMediaUrl(params: {
  assetId: string;
  audience?: MediaUrlAudience;
  ttlSeconds?: number;
}): string {
  const audience = params.audience ?? 'game';
  const ttl = params.ttlSeconds ?? (audience === 'host' ? MEDIA_HOST_URL_TTL_SECONDS : MEDIA_URL_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = signMediaAccess({ assetId: params.assetId, audience, expiresAtEpochSeconds: exp });
  return `/api/v1/media/${params.assetId}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

/** Prüft eine Signed-URL (assetId, audience, exp, sig). Timing-safe. */
export function verifySignedAccess(params: {
  assetId: string;
  audience: MediaUrlAudience;
  exp?: string;
  sig?: string;
}): boolean {
  const { assetId, audience, exp, sig } = params;
  if (!exp || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum)) return false;
  if (expNum <= Math.floor(Date.now() / 1000)) return false; // abgelaufen
  const expected = signMediaAccess({ assetId, audience, expiresAtEpochSeconds: expNum });
  const given = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}
