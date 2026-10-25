import { readGameResult, publicResultView } from '../games/core/results.js';
import { ContentError, contentActor, selectRoomContent, applyPinnedContent } from '../content/core.js';
import { ZodError } from 'zod';
import { rankScores } from '../games/core/roundFlow.js';
// ============================================================
// Online Quiz Plattform - Rooms Router
// ============================================================

import { RoomError, joinPlayer, roomPolicy, tokenHash, mutateRoom, lifecycle } from '../rooms/core.js';
import { changed, closeRoomSockets } from '../rooms/socket.js';
import type { Server } from 'socket.io';
import { Router } from 'express';
import crypto from 'crypto';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';
import { prisma } from '../persistence/prisma.js';
import { verifySession } from '../auth/session.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';
import { CreateRoomSchema, JoinRoomSchema, validateBody } from './validators.js';
import { resolveCanonicalSlug, getGameManifest, PublicRoomSummarySchema, type GameManifest } from '@quiz/shared';
import { bindSnapshotAssetsToRoom } from '../media/lifecycle.js';
import { isStartableSlug } from '../games/registry.js';

export const roomsRouter : ReturnType<typeof Router> = Router();

// PR11-Nacharbeit E: Doppelklick/Retry bei POST /rooms begrenzen. In der
// BETA ist die Raumerstellung NICHT vollständig idempotent (ein zweiter
// Klick erzeugt einen zweiten Raum); ein Rate-Limiter verhindert damit
// versehentlich mehrere Räume. Wie joinLimiter: nur in Produktion wirksam.
const createLimiter = process.env.NODE_ENV === 'production'
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 Minuten
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { code: 'RATE_LIMIT', message: 'Zu viele Raum-Erstellungen. Bitte 15 Minuten warten.' } },
    })
  : (_req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => next();

/** Erkennt Prisma-Unique-Konflikte (P2002) robust an code/message. */
function isUniqueConflict(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: string; message?: string };
  if (e.code === 'P2002') return true;
  return typeof e.message === 'string' && /Unique constraint failed|UNIQUE constraint failed/i.test(e.message);
}

// ------------------------------------------------------------
// Audit 11-06 (P1): serverseitige Idempotenz für Raum-Erstellung.
//
// Zwei Mechanismen, beide schreiben Room.idempotencyKey
// (@@unique([idempotencyKey, createdByUserId])):
//   (a) Explizites Idempotency-Token des Clients (UUID, max 128): ein
//       Retry/Doppelklick sendet dasselbe Token → derselbe Raum, exakt und
//       zeitlich unbegrenzt. Ein bewusst neuer Raum verwendet ein neues
//       Token. Wiederverwendung eines Tokens mit ABWEICHENDER Konfiguration
//       liefert den EXISTIERENDEN Raum (vertragliche Idempotenz: das Token
//       identifiziert die Absicht, nicht die Payload).
//   (b) Inhaltliches Fingerprint (tokenlose Bestandsclients, parallele
//       identische Requests): deterministischer Hash über die VOLLSTÄNDIGE,
//       wirksame Konfiguration (Spiel, Name, Setup, PIN-Hash, Limits,
//       Viewer/Camera/Chat/Public) — JSON rekursiv key-sorted, damit die
//       Schlüsselreihenfolge keine zweite Identität erzeugt. Der Fingerprint
//       gilt nur innerhalb derselben festen Uhrzeit-Minute: der Schlüssel enthält
//       eine feste Minutenepoche → über die Minutengrenze kann dieselbe
//       Konfiguration bewusst einen NEUEN Raum anlegen. Verschiedene tokenlose
//       Absichten mit gleicher Konfiguration werden
//       innerhalb derselben Minute zusammengeführt. Auch ein Retry 20 ms
//       später kann über die Minutengrenze einen zweiten Raum erzeugen.
//       Eine Absichts-/Retry-Garantie setzt deshalb das Client-Token voraus.
// Parallele identische Requests kollidieren per P2002 auf den Gewinner.
// Raum + Host-Teilnahme entstehen ATOMAR (Transaction) — es gibt keinen
// Zustand mit Raum aber ohne HOST-Teilnahme/Token.
// ------------------------------------------------------------
const IDEM_WINDOW_MS = 60 * 1000;

/** Rekursive, deterministische JSON-Stringifikation (Keys alphabetisch). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Erzeugt den window-gebundenen Fingerprint-Schlüssel (konkreter Vergleich). */
function computeRoomFingerprint(cfg: Record<string, unknown>): string {
  const epoch = Math.floor(Date.now() / IDEM_WINDOW_MS);
  const digest = crypto.createHash('sha256').update(canonicalJson({ epoch, cfg })).digest('hex');
  return `fp:${epoch}:${digest}`;
}

/**
 * Stellt sicher, dass für den Raum genau eine Moderator-Teilnahme existiert
 * (Crash-Recovery zwischen Room-Insert und Participation-Insert, bzw.
 * paralleler P2002-Gewinner ohne eigene Teilnahme). @returns die Teilnahme.
 */
async function ensureModeratorParticipation(
  roomId: string,
  displayName: string,
): Promise<{ id: string; rejoinToken: string } | null> {
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
  const existing = await prisma.participation.findFirst({ where: { roomId, role: 'HOST' } });
  if (existing) return prisma.participation.update({ where: { id: existing.id }, data: { userId: room.hostUserId, hasSeenHostSecrets: true } });
  if (await prisma.participation.findFirst({ where: { roomId, userId: room.hostUserId, role: { in: ['PLAYER', 'VIEWER'] }, kickedAt: null, leftAt: null } })) return null;
  const created = await prisma.participation.create({
    data: {
      roomId,
      displayName,
      normalizedName: displayName.toLowerCase().trim(),
      role: 'HOST',
      userId: room.hostUserId,
      hasSeenHostSecrets: true,
      connected: true,
      ready: true,
      rejoinToken: crypto.randomUUID(),
      rejoinTokenVersion: 1,
    },
  });
  return created;
}

// ------------------------------------------------------------
// Startfähigkeit serverseitig prüfen (Regelwerk §13.1, §14).
//
// Eine Raum darf NUR erstellt werden, wenn das Spiel:
//   1. einen echten Engine-Handler in der Registry hat (keine
//      Placeholders), UND
//   2. den ehrlichen Status AVAILABLE/BETA hat (kein PLANNED/HIDDEN) —
//      geprüft für die TATSÄCHLICH angeforderte DB-Definition (darauf bindet
//      der Raum) UND für das kanonische Manifest.
//
// Die Prüfung gilt für BEIDE Aufrouten: gameSlug UND gameDefinitionId. Ein
// PLANNED- oder HIDDEN-Spiel, dessen Definition in der DB existiert (z.B. wie
// nach dem Seed), ist trotzdem NICH startbar → GAME_NOT_STARTABLE.
//
// KRITISCH (gameDefinitionId): Eine als HIDDEN markierte Legacy-Definition
// (z.B. „geo" nach einer Kollisions-Migration) wird NICHT gestartet, selbst
// wenn ihr Slug auf ein startbares kanonisches Spiel (wissensduell) verweist.
// Der Status der tatsächlich angeforderten Datenbankzeile zählt, nicht nur
// der des kanonischen Manifests.
// ------------------------------------------------------------
export function classifyRoomCreationError(
  args: {
    /** Status der tatsächlich angeforderten DB-Definition (Bind-Ziel des Raums). */
    requestedStatus?: string | null;
    /** Kanonisches Manifest (Single Source of Truth). */
    manifest?: Pick<GameManifest, 'slug' | 'status'> | null;
    /** true, wenn die Registry für den aufgelösten kanonischen Slug einen echten Engine-Handler hat. */
    startable: boolean;
  },
): { code: string; message: string } | null {
  // 1) Echte Engine vorhanden (Regelwerk §13.1: keine no-op-Placeholders).
  if (!args.startable) {
    return { code: 'GAME_NOT_STARTABLE', message: 'Dieses Spiel ist noch nicht startbar (keine Engine implementiert).' };
  }
  // 2) Status der TATSÄCHLICH angeforderten DB-Definition. Der Raum wird auf
  //    genau diese Zeile gebunden — ihr Status ist maßgeblich, unabhängig vom
  //    kanonischen Manifest (HIDDEN-Legacy-„geo" verweist auf wissensduell,
  //    darf aber nicht gestartet werden).
  if (
    args.requestedStatus != null
    && args.requestedStatus !== 'AVAILABLE'
    && args.requestedStatus !== 'BETA'
  ) {
    return { code: 'GAME_NOT_STARTABLE', message: `Spielstatus „${args.requestedStatus}“ — Raumerstellung ist dafür gesperrt.` };
  }
  // 3) Kanonisches Manifest-Status (Regelwerk §13.1/§12.1).
  if (args.manifest && args.manifest.status !== 'AVAILABLE' && args.manifest.status !== 'BETA') {
    return { code: 'GAME_NOT_STARTABLE', message: `Spielstatus „${args.manifest.status}“ — Raumerstellung ist dafür gesperrt.` };
  }
  return null;
}

// Generate unique room code using crypto
function generateRoomCode(): string {
  const d1 = crypto.randomInt(0, 1000);
  const d2 = crypto.randomInt(0, 1000);
  return `${String(d1).padStart(3, '0')}-${String(d2).padStart(3, '0')}`;
}

// Normalize room code to NNN-NNN format
// Accepts: NNN-NNN, NNNNNN, NNN NNN, strips spaces/dashes
export function normalizeRoomCode(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '').slice(0, 6);
  if (digits.length < 6) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

// GET /api/v1/rooms/public - List public rooms
roomsRouter.get('/public', async (_req, res) => {
  try {
    const rooms = await prisma.room.findMany({
      where: {
        isPublic: true,
        status: { in: ['LOBBY', 'RUNNING'] },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          { OR: [{ lifecycle: null }, { lifecycle: { notIn: ['DRAFT_ROOM', 'EXPIRED', 'CLOSED'] } }] },
        ],
      },
      select: {
        id: true,
        code: true,
        roomName: true,
        status: true,
        runPhase: true,
        maxPlayers: true,
        allowViewers: true,
        cameraEnabled: true,
        lifecycle: true,
        expiresAt: true,
        scheduledAt: true,
        roomPolicyJson: true,
        pinHash: true,
        viewerRequiresPin: true,
        gameDefinition: {
          select: {
            slug: true,
            name: true,
            category: true,
            maxPlayers: true,
          },
        },
        _count: {
          select: {
            participations: {
              where: { role: 'PLAYER', admission: 'ACTIVE', leftAt: null, kickedAt: null, bannedAt: null },
            },
            viewerSessions: { where: { connected: true } },
          },
        },
        participations: {
          where: { role: 'VIEWER', admission: 'ACTIVE', connected: true, leftAt: null, kickedAt: null, bannedAt: null },
          select: { id: true },
        },
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      success: true,
      data: rooms.map(r => {
        const phase = lifecycle(r), policy = roomPolicy(r);
        const maxPlayers = Math.min(r.maxPlayers, r.gameDefinition.maxPlayers);
        const waiting = r._count.participations >= maxPlayers;
        const canJoin = (phase === 'LOBBY_OPEN' || (['GAME_ACTIVE', 'PAUSED'].includes(phase) && policy.allowLateJoin && isStartableSlug(r.gameDefinition.slug)))
          && policy.playerAccess !== 'INVITE_ONLY' && (!waiting || policy.waitlist);
        return PublicRoomSummarySchema.parse({
        id: r.id,
        code: r.code,
        roomName: r.roomName,
        status: r.status,
        runPhase: r.runPhase,
        maxPlayers,
        lifecycle: phase,
        scheduledAt: r.scheduledAt?.toISOString() ?? null,
        canJoin, waitlist: waiting && policy.waitlist, accessMode: policy.playerAccess,
        allowViewers: r.allowViewers,
        cameraEnabled: r.cameraEnabled,
        game: { slug: r.gameDefinition.slug, name: r.gameDefinition.name, category: r.gameDefinition.category },
        playerCount: r._count.participations,
        viewerCount: r._count.viewerSessions + r.participations.length,
        createdAt: r.createdAt.toISOString(),
      }); }),
    });
  } catch (error) {
    logger.error('Failed to list rooms', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Räume konnten nicht geladen werden.' },
    });
  }
});

// POST /api/v1/rooms - Create room (Moderator only)
roomsRouter.post('/', createLimiter, async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' },
      });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
      });
    }

    const parsed = validateBody(CreateRoomSchema, req.body, res);
    if (!parsed) return;

    const {
      gameSlug,
      gameDefinitionId,
      roomName,
      pin,
      maxPlayers,
      cameraEnabled,
      allowViewers,
      viewerRequiresPin,
      viewerLimit,
      lobbyChatEnabled,
      setupSnapshotJson,
      isPublic,
      idempotencyKey,
      roomPolicy: policy,
    } = parsed;

    // Resolve game definition: prefer slug (mit Legacy-Auflösung), fallback to id
    let resolvedGameDefId = gameDefinitionId;
    let gameDef: { id: string; slug: string; status: string } | null = null;

    if (!gameDefinitionId && gameSlug) {
      // Legacy-Slugs (z.B. "geo", "weristdas") werden auf den kanonischen
      // Slug aufgelöst, damit alte Clients/Legacy-Links kontrolliert auf den
      // kanonischen Pfad übergehen. (Regelwerk §5.23, §12.1)
      const canonicalSlug = resolveCanonicalSlug(gameSlug) ?? gameSlug;
      gameDef = await prisma.gameDefinition.findUnique({
        where: { slug: canonicalSlug },
      });
      if (!gameDef) {
        return res.status(400).json({
          success: false,
          error: { code: 'GAME_NOT_FOUND', message: 'Spiel nicht gefunden.' },
        });
      }
      resolvedGameDefId = gameDef.id;
    } else if (gameDefinitionId) {
      // Direkte Angabe über gameDefinitionId: die Definition laden, um
      // Status + Engine-Handler ebenfalls serverseitig zu prüfen.
      gameDef = await prisma.gameDefinition.findUnique({
        where: { id: gameDefinitionId },
      });
      if (!gameDef) {
        return res.status(400).json({
          success: false,
          error: { code: 'GAME_NOT_FOUND', message: 'Spiel nicht gefunden.' },
        });
      }
    }

    if (!resolvedGameDefId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION', message: 'Spiel (slug oder id) erforderlich.' },
      });
    }

    // Startfähigkeits-Prüfung (Regelwerk §13.1): echte Engine + ehrlicher Status.
    // Gilt für gameSlug UND gameDefinitionId — ein PLANNED/HIDDEN-Spiel mit
    // existierender Definition ist trotzdem nicht startbar. Maßgeblich ist der
    // Status der TATSÄCHLICH angeforderten DB-Definition (Bind-Ziel des Raums),
    // zusätzlich das kanonische Manifest und der Engine-Handler.
    const canonicalSlug = gameDef ? resolveCanonicalSlug(gameDef.slug) ?? gameDef.slug : null;
    const startable = canonicalSlug ? isStartableSlug(canonicalSlug) : false;
    const manifest = canonicalSlug ? getGameManifest(canonicalSlug) : null;
    const startErr = classifyRoomCreationError({
      requestedStatus: gameDef?.status,
      manifest,
      startable,
    });
    if (startErr) {
      return res.status(400).json({ success: false, error: startErr });
    }

    // Audit 11-06: PIN-Hash für den Raum (argon2id) + DETERMINISTISCHE
    // PIN-Identität für den Fingerprint. Der Argon2-Hash ist salzig und damit
    // NICHT deterministisch — für den Fingerprint dient der Salt-Hash
    // (gleiche PIN → gleiche Identität, rohe PIN wird nie gespeichert/
    // protokolliert). Ohne PIN: beides null → gleicher Fingerprint-Anteil.
    const pinHash = pin ? await argon2.hash(pin, { type: argon2.argon2id }) : null;
    const pinFingerprint = pin ? crypto.createHash('sha256').update(`room-pin:${pin}`).digest('hex') : null;

    // Audit 11-06 (P1): serverseitige Idempotenz für Raum-Erstellung.
    // (a) Explizites Idempotency-Token des Clients: exakt und zeitlich
    //     unbegrenzt — gleiche Absicht (gleiche Token) → genau ein Raum;
    //     anderes Token → bewusst neue Absicht → neuer Raum, selbst bei
    //     identischer Konfiguration.
    // (b) Fingerprint über die VOLLSTÄNDIGE wirksame Konfiguration inkl.
    //     PIN-Identität und fester Minutenepoche im Schlüssel: FALLBACK nur
    //     für tokenlose Bestandsclients. WICHTIG (Vertrag, 10.10.):
    //     Identischer Inhalt allein unterscheidet einen Retry NICHT von
    //     einer neuen Erstellungsabsicht — zwei bewusste, in schneller
    //     Folge innerhalb derselben Uhrzeit-Minute erfolgte Erstellungen mit
    //     identischer
    //     Konfiguration werden IM EINEN Raum zusammengeführt. Der
    //     Fingerprint ist daher KEINE allgemeine Idempotenz-Garantie,
    //     sondern ein enger Doppelklick-Retrieschutz: andere Absichten
    //     müssen ein Token senden (aktuelle Web-Setup-Seiten tun das
    //     immer: ModeratorSetup/GeoSetup/JeopardySetup/WerIstDasSetup).
    const fpCfg = {
      game: resolvedGameDefId,
      name: roomName,
      setup: setupSnapshotJson,
      pin: pinFingerprint,
      maxPlayers,
      cameraEnabled,
      allowViewers,
      viewerRequiresPin,
      viewerLimit,
      lobbyChatEnabled,
      isPublic: isPublic ?? true,
      roomPolicy: policy,
    };
    const idemKey = idempotencyKey ?? computeRoomFingerprint(fpCfg);
    const existingRoom = await prisma.room.findFirst({
      where: { idempotencyKey: idemKey, createdByUserId: session.userId },
    });
    if (existingRoom) {
      // Wiederversicherung (Crash-Recovery): ein Raum ohne Moderator-Teilnahme
      // (Prozessunterbruch zwischen Room-Insert und Participation-Insert) wird
      // hier zu Ende gebracht — die Replay-Antwort liefert niemals
      // moderatorToken: null.
      const mod = existingRoom.hostUserId === session.userId ? await ensureModeratorParticipation(existingRoom.id, session.user.displayName) : null;
      logger.info('Room creation idempotent (existing room returned)', { roomId: existingRoom.id });
      return res.status(201).json({
        success: true,
        data: { code: existingRoom.code, roomId: existingRoom.id, moderatorToken: mod?.rejoinToken ?? null, idempotentReplay: true },
      });
    }

    // Generate unique code
    let code: string;
    let attempts = 0;
    do {
      code = generateRoomCode();
      const existing = await prisma.room.findUnique({ where: { code } });
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      return res.status(500).json({
        success: false,
        error: { code: 'CODE_COLLISION', message: 'Raumcode konnte nicht generiert werden.' },
      });
    }

    // PR11-Nacharbeit D: Raum-Setup-Schema-Version EHRLICH (Regelwerk §5.23).
    // Wird NUR beim Erstellen gesetzt (bestehende Räume/Zeilen werden nie
    // hier überschrieben). Ableitung aus dem Snapshot ohne stille
    // Umschreibung: top-level `setupSchemaVersion` ist maßgeblich (der
    // Writer v2+ und der Reader `WerIstDasSetupSchema` nutzen denselben
    // Feldnamen); sonst strukturell — eine Runde in v2-Form
    // (gameImageAssetId) verlangt Version 2, andernfalls 1 (Legacy).
    // Für andere Spiele (kein solches Feld) bleibt der Default 1.
    const roomSetupSchemaVersion = (() => {
      const raw = typeof setupSnapshotJson === 'string' ? setupSnapshotJson : JSON.stringify(setupSnapshotJson ?? {});
      try {
        const parsed = JSON.parse(raw) as {
          setupSchemaVersion?: unknown;
          rounds?: Array<Record<string, unknown> | null>;
        };
        if (parsed.setupSchemaVersion === 2) return 2;
        const hasV2Round = Array.isArray(parsed.rounds) && parsed.rounds.some(
          r => r && (typeof r.gameImageAssetId === 'string' || r.setupVersion === 2),
        );
        return hasV2Round ? 2 : 1;
      } catch { return 1; }
    })();

    // Create room + host participation ATOMAR (Audit 11-06):
    // eine Race-Antwort darf keinen halb angelegten Raum (ohne Moderator)
    // und kein null-Host-Token liefern. Interaktive Transaktion: beide
    // Inserts in einem Batch (all-or-nothing), danach SOFORT die
    // Moderator-Teilnahme nachlesen (im selben Request, vor der Antwort).
    let room;
    let moderatorToken: string | null = null;
    try {
      room = await prisma.$transaction(async (tx) => {
        // Server materializes authorized READY content; client-provided payloads
        // never become trusted engine snapshots.
        const contentItems = setupSnapshotJson.contentSelection === undefined ? [] : await selectRoomContent(tx,
          await contentActor(tx, sessionId), resolveCanonicalSlug(gameDef!.slug) ?? gameDef!.slug, setupSnapshotJson.contentSelection);
        const materializedSetup = contentItems.length ? applyPinnedContent(setupSnapshotJson,
          resolveCanonicalSlug(gameDef!.slug) ?? gameDef!.slug, contentItems) : setupSnapshotJson;
        const createdRoom = await tx.room.create({
          data: {
            code,
            roomName,
            gameDefinitionId: resolvedGameDefId,
            hostUserId: session.userId,
            pinHash,
            maxPlayers,
            cameraEnabled,
            allowViewers,
            viewerRequiresPin,
            viewerLimit,
            lobbyChatEnabled,
            setupSnapshotJson: JSON.stringify(materializedSetup),
            setupSchemaVersion: roomSetupSchemaVersion,
            isPublic: isPublic ?? true,
            idempotencyKey: idemKey,
            createdByUserId: session.userId,
            roomPolicyJson: policy ? JSON.stringify(policy) : null,
            status: 'LOBBY',
            runPhase: 'OPEN',
          },
        });
        for (const [position, item] of contentItems.entries()) await tx.contentUse.create({ data: { roomId: createdRoom.id, runIndex: createdRoom.runIndex,
          itemId: item.id, itemRevision: item.revision, position, snapshotJson: JSON.stringify(item) } });
        const modPart = await tx.participation.create({
          data: {
            roomId: createdRoom.id,
            displayName: session.user.displayName,
            normalizedName: session.user.displayName.toLowerCase().trim(),
            role: 'HOST',
            hasSeenHostSecrets: true,
            userId: session.userId,
            connected: true,
            ready: true,
            rejoinToken: crypto.randomUUID(),
            rejoinTokenVersion: 1,
          },
        });
        if (policy && policy.teamMode !== 'OFF') for (let i = 0; i < policy.teamCount; i++) await tx.roomTeam.create({ data: { roomId: createdRoom.id, name: `Team ${i + 1}`, icon: '👥', color: ['#2563eb', '#dc2626', '#16a34a', '#9333ea'][i % 4] } });
        moderatorToken = modPart.rejoinToken;
        return createdRoom;
      });
    } catch (error) {
      // Audit 11-06: parallele identische Request — ein zweiter Thread hat
      // dasselbe Idempotency-Token zuerst gespeichert (P2002). Auf den
      // Gewinner-Raum auflösen (gleiche Identität zurückgeben).
      if (isUniqueConflict(error)) {
        const winner = await prisma.room.findFirst({
          where: { idempotencyKey: idemKey, createdByUserId: session.userId },
        });
        if (winner) {
          const mod = winner.hostUserId === session.userId ? await ensureModeratorParticipation(winner.id, session.user.displayName) : null;
          return res.status(201).json({
            success: true,
            data: { code: winner.code, roomId: winner.id, moderatorToken: mod?.rejoinToken ?? null, idempotentReplay: true },
          });
        }
      }
      throw error;
    }

    // moderatorToken stammt aus der Transaktion (atomar angelegt).
    // Fallback: falls (historisch/unerwartet) nichts gesetzt ist, neu lesen.
    if (!moderatorToken) {
      const moderatorParticipation = await prisma.participation.findFirst({
        where: { roomId: room.id, role: 'HOST' },
      });
      moderatorToken = moderatorParticipation?.rejoinToken ?? null;
    }

    // PR11-Nacharbeit E: kontrollierte Bindung der vor der Raumerstellung
    // erzeugten tmp-Composite(s) an den echten Raum. Fail-tolerant: ein
    // Fehlschlag der Bindung macht die Raumerstellung NICHT ungültig
    // (Assets bleiben owner-only tmp; Startvalidierung prüft Eigentum +
    // Provenienz, nicht roomId). Idempotent bei doppelter POST /rooms.
    try {
      await bindSnapshotAssetsToRoom(prisma, {
        roomId: room.id, hostUserId: session.userId, snapshotJson: room.setupSnapshotJson,
      });
    } catch (bindError) {
      logger.warn('Temp-Asset-Bindung fehlgeschlagen (Raum bleibt nutzbar)', { roomId: room.id, error: bindError });
    }

    logger.info('Room created', { roomId: room.id, code, hostId: session.userId });

    res.status(201).json({
      success: true,
      data: {
        code: room.code,
        roomId: room.id,
        moderatorToken,
      },
    });
  } catch (error) {
    if (error instanceof ContentError || error instanceof ZodError) return res.status(error instanceof ContentError ? error.status : 400).json({ success: false,
      error: { code: error instanceof ContentError ? error.code : 'INVALID_CONTENT_SELECTION', message: 'Inhaltsauswahl prüfen.' } });
    logger.error('Failed to create room', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Raum konnte nicht erstellt werden.' },
    });
  }
});

// GET /api/v1/rooms/:code - Get room details
roomsRouter.get('/:code', async (req, res) => {
  try {
    // Check if user is authenticated
    const sessionId = verifySession(req, config.sessionSecret);
    let isAuthenticated = false;
    let userId: string | null = null;

    if (sessionId) {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { user: true },
      });
      if (session && !session.revokedAt && session.expiresAt >= new Date()) {
        isAuthenticated = true;
        userId = session.userId;
      }
    }

    const room = await prisma.room.findUnique({
      where: { code: normalizeRoomCode(req.params.code) },
      include: {
        gameDefinition: true,
        participations: {
          where: { role: { not: 'VIEWER' } },
          select: {
            id: true,
            displayName: true,
            role: true,
            connected: true,
            ready: true,
            avatarMode: true,
            avatarGenerated: true,
            score: true,
            lives: true,
          },
        },
        _count: {
          select: { viewerSessions: true },
        },
      },
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    // Only show isPublic rooms to non-authenticated users
    // Authenticated moderators can see their own rooms regardless of isPublic
    if (!isAuthenticated && !room.isPublic) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }
    if (isAuthenticated && !room.isPublic && room.hostUserId !== userId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    res.json({
      success: true,
      data: {
        id: room.id,
        code: room.code,
        roomName: room.roomName,
        status: room.status,
        runPhase: room.runPhase,
        maxPlayers: room.maxPlayers,
        cameraEnabled: room.cameraEnabled,
        allowViewers: room.allowViewers,
        game: room.gameDefinition,
        players: room.participations.map(p => ({
          id: p.id,
          displayName: p.displayName,
          role: p.role,
          connected: p.connected,
          ready: p.ready,
          score: p.score,
          lives: p.lives,
        })),
        viewerCount: room._count.viewerSessions,
        createdAt: room.createdAt,
      },
    });
  } catch (error) {
    logger.error('Failed to get room', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Raum konnte nicht geladen werden.' },
    });
  }
});

// Rate limit join attempts to prevent brute-force PIN attacks
const joinLimiter = process.env.NODE_ENV === 'production'
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { code: 'RATE_LIMIT', message: 'Zu viele Beitrittsversuche. Bitte 15 Minuten warten.' } },
    })
  : (_req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => next();

// POST /api/v1/rooms/:code/join - Player join
roomsRouter.post('/:code/join', joinLimiter, async (req, res) => {
  try {
    const parsed = validateBody(JoinRoomSchema, req.body, res);
    if (!parsed) return;

    const { displayName, pin } = parsed;

    const roomCode = req.params.code as string;
    const room = await prisma.room.findUnique({
      where: { code: normalizeRoomCode(roomCode) },
      include: { gameDefinition: { select: { slug: true } } },
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    if (room.status !== 'LOBBY' && !(room.status === 'RUNNING' && roomPolicy(room).allowLateJoin)) {
      return res.status(400).json({
        success: false,
        error: { code: 'ROOM_NOT_JOINABLE', message: 'Raum ist nicht mehr beitretbar.' },
      });
    }

    // Wer ist das? (BETA): Der Raum-Host hat die Originale + Namen selbst
    // eingegeben und damit Wissensvorteil (Arbeitsauftrag §2C, Regelwerk §2:
    // administrierende Rolle ≠ Informationsrecht). Client-seites Verstecken
    // löst diesen Vorteil NICHT — daher wird das Mitspielen des Host-Kontos
    // in der eigenen wer-ist-das-Runde serverseitig verhindert.
    // Anonyme Spieler (ohne Login) sind davon nicht betroffen; das ist der
    // vorgesehene faire Modus.
    if (room.gameDefinition.slug === 'wer-ist-das') {
      const joiningSessionId = verifySession(req, config.sessionSecret);
      if (joiningSessionId && room.hostUserId) {
        const joiningSession = await prisma.session.findUnique({ where: { id: joiningSessionId } });
        if (joiningSession && !joiningSession.revokedAt && joiningSession.expiresAt > new Date()
            && joiningSession.userId === room.hostUserId) {
          return res.status(403).json({
            success: false,
            error: {
              code: 'HOST_CANNOT_PLAY_OWN_ROUND',
              message: 'Wer die Bilder und Namen eingegeben hat, kann in dieser Runde nicht blind mitraten.',
            },
          });
        }
      }
    }

    const joiningSessionId = verifySession(req, config.sessionSecret);
    const joiningSession = joiningSessionId ? await prisma.session.findFirst({ where: { id: joiningSessionId, revokedAt: null, expiresAt: { gt: new Date() } } }) : null;
    let guestKey = req.cookies?.quiz_guest as string | undefined;
    if (!guestKey || !/^[a-f0-9]{64}$/.test(guestKey)) {
      guestKey = crypto.randomBytes(32).toString('hex');
      res.cookie('quiz_guest', guestKey, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 86400000 });
    }
    const participation = await joinPlayer(room.id, { displayName, pin, inviteToken: parsed.inviteToken, userId: joiningSession?.userId, guestKeyHash: tokenHash(guestKey) });
    const newRejoinToken = participation.rejoinToken;
    const io = (globalThis as { __quiz_io?: Server }).__quiz_io;
    if (io) changed(io, room.id);

    logger.info('Player joined', { roomId: room.id, participationId: participation.id });

    res.status(201).json({
      success: true,
      data: {
        rejoinToken: newRejoinToken,
        admission: participation.admission,
        participationId: participation.id,
        role: 'PLAYER',
        roomCode: room.code,
      },
    });
  } catch (error) {
    if (error instanceof RoomError) return res.status(error.code === 'INVALID_PIN' ? 403 : 400).json({ success: false, error: { code: error.code, message: error.code } });
    logger.error('Failed to join room', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Beitritt fehlgeschlagen.' },
    });
  }
});

// DELETE /api/v1/rooms/:code - Close room (moderator only)
roomsRouter.delete('/:code', async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' },
      });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
      });
    }

    const roomData = await prisma.room.findUnique({
      where: { code: normalizeRoomCode(req.params.code) },
    });

    if (!roomData) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    // Only host can close their room
    if (roomData.hostUserId !== session.userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Nur der Raum-Ersteller kann den Raum schließen.' },
      });
    }

    if (roomData.status === 'ARCHIVED') return res.json({ success: true });
    await mutateRoom(roomData.id, { participantId: `http:${session.id}`, userId: session.userId, sessionId: session.id, permissions: new Set(), canManage: true }, { type: 'CLOSE' });
    const room = roomData;
    const io = (globalThis as { __quiz_io?: Server }).__quiz_io;
    if (io) closeRoomSockets(io, room.id);
    logger.info('Room closed', { roomId: room.id, code: room.code });
    res.json({ success: true });
  } catch (error) {
    if (error instanceof RoomError) return res.status(409).json({ success: false, error: { code: error.code, message: error.code } });
    logger.error('Failed to close room', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Raum konnte nicht geschlossen werden.' },
    });
  }
});

// GET /api/v1/rooms/:code/results?runIndex=N&revision=N — immutable public result projection.
roomsRouter.get('/:code/results', async (req, res) => {
  try {
    const room = await prisma.room.findUnique({ where: { code: normalizeRoomCode(req.params.code) }, include: { gameDefinition: true } });
    if (!room) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' } });
    const sessionId = verifySession(req, config.sessionSecret);
    const session = sessionId ? await prisma.session.findFirst({ where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } } }) : null;
    const rejoinToken = req.get('X-Rejoin-Token');
    const member = rejoinToken ? await prisma.participation.findFirst({ where: { roomId: room.id, rejoinToken, kickedAt: null, bannedAt: null, leftAt: null, admission: 'ACTIVE' } }) : null;
    const publicRead = room.isPublic && roomPolicy(room).viewerAccess === 'PUBLIC_JOIN';
    if (!publicRead && session?.userId !== room.hostUserId && !member) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Kein Zugriff auf dieses Ergebnis.' } });
    const parseIndex = (value: unknown) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
    const runIndex = req.query.runIndex === undefined ? room.runIndex : parseIndex(req.query.runIndex);
    const revision = req.query.revision === undefined ? undefined : parseIndex(req.query.revision);
    if (!runIndex || revision === null) return res.status(400).json({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'Ungültige Ergebnisversion.' } });
    const read = await readGameResult(room.id, runIndex, revision);
    if (read) return res.json({ success: true, data: publicResultView(room.code, read) });
    // Pre-migration results are explicitly legacy snapshots; never auto-finalize or silently invent a ledger.
    const archived = await prisma.roomRun.findUnique({ where: { roomId_runIndex: { roomId: room.id, runIndex } } });
    if (!archived && (runIndex !== room.runIndex || room.status !== 'ENDED')) return res.status(404).json({ success: false, error: { code: 'RESULTS_NOT_AVAILABLE', message: 'Ergebnisse noch nicht verfügbar.' } });
    const players: Array<{ id: string; displayName: string; score: number }> = archived ? JSON.parse(archived.scoresJson) : await prisma.participation.findMany({ where: { roomId: room.id, role: 'PLAYER' } });
    const legacyGame = archived ? await prisma.gameDefinition.findUniqueOrThrow({ where: { id: archived.gameDefinitionId } }) : room.gameDefinition;
    return res.json({ success: true, data: { roomCode: room.code, roomName: room.roomName, status: 'ENDED', runPhase: 'RESULTS', runIndex, resultStatus: null, resultRevision: null, legacy: true,
      game: { slug: legacyGame.slug, name: legacyGame.name }, scores: rankScores(players).map(p => ({ rank: p.rank, participationId: p.id, displayName: p.displayName, role: 'PLAYER', score: p.score })), endedAt: archived?.endedAt ?? room.endedAt } });
  } catch (error) {
    logger.error('Failed to get results', { error });
    const missing = error instanceof Error && error.message === 'RESULT_REVISION_NOT_FOUND';
    res.status(missing ? 404 : 500).json({ success: false, error: { code: missing ? 'RESULT_REVISION_NOT_FOUND' : 'INTERNAL_ERROR', message: 'Ergebnisse konnten nicht geladen werden.' } });
  }
});
