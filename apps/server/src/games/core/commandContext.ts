// ============================================================
// Protocol + Command Envelope Gate (BASIS-STANDARDS, Master §5.17, §12.4)
// ============================================================
// Serverseitiges Gegenstück zum Client-Contract:
//   - protocolVersion wird an der Mutationsgrenze ausgewertet.
//   - Eine EXPLIZIT inkompatible Version → CLIENT_VERSION_UNSUPPORTED
//     VOR jeder Mutation.
//   - Fehlende Version (Legacy-Client) → dokumentierter
//     Kompatibilitätsweg: gilt als PROTOCOL_VERSION (1), wird getestet.
//   - commandId/requestId + expectedRevision/stateVersion werden
//     kompatibel aufgelöst; Widersprüche → INVALID_PAYLOAD.
//   - Client-Raumangaben ersetzen KEINE Membership: roomId stammt
//     immer aus der serverseitigen Socket-Identität.
//
// Replay-Grenze (ehrlich): Ohne commandId/requestId im Payload läuft
// die Aktion im Legacy-Modus OHNE Receipt-Wiederholungsschutz
// (vorhandenes Verhalten). Kritische Mutationen erhalten Receipt-Schutz
// nur, wenn der Client ein Absichtstoken mitschickt — die Frontend-
// Adapter erzeugen es seit BASIS-STANDARDS.
// ============================================================

import {
  PROTOCOL_VERSION,
  isSupportedProtocolVersion,
  resolveCommandEnvelope,
  resolveProtocolVersion,
  type CommandEnvelope,
} from '@quiz/shared';
import { getSocketDataIdentity } from '../../sockets/auth.js';
import { getSocketIdentity } from '../../http/middleware/auth.js';
import { z } from 'zod';

const commandFields = z.object({
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  stateVersion: z.number().int().nonnegative().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  roomCode: z.string().optional(),
});

export interface CommandContext {
  roomId: string;
  /** Serverseitig aufgelöster Akteur (nie client-behauptet). */
  actorId: string;
  actorRole: string;
  commandId?: string;
  /** true = client hat ein Absichtstoken gesendet → Replay-Schutz aktiv. */
  commandMode: boolean;
  envelope?: CommandEnvelope;
}

export type CommandContextResult =
  | { ok: true; ctx: CommandContext }
  | { ok: false; error: 'NOT_IN_ROOM' | 'CLIENT_VERSION_UNSUPPORTED' | 'INVALID_PAYLOAD' };

/**
 * Prüft die (optional explizit gesendete) Protokollversion einer Mutation.
 * Rückgabe: null = ok, sonst der Ablehnungscode.
 */
export function checkCommandProtocolVersion(explicit: unknown): 'CLIENT_VERSION_UNSUPPORTED' | null {
  if (explicit === undefined || explicit === null) return null; // Legacy-Kompat
  if (isSupportedProtocolVersion(explicit)) return null;
  return 'CLIENT_VERSION_UNSUPPORTED';
}

/**
 * Löst die Command-Kontextdaten aus Payload + Socket-Identität auf.
 * `protocolVersion` ist das optionale `protocolVersion`-Feld der Payload:
 *   - fehlt/null → Legacy-Kompatibilitätsweg (gilt als PROTOCOL_VERSION)
 *   - 1 (oder allgemein unterstützt) → ok
 *   - sonst → CLIENT_VERSION_UNSUPPORTED, VOR jeder Mutation.
 * roomId/actorId stammen AUSSCHLIESSLICH aus der serverseitigen
 * Socket-Identität — client-behaftete Angaben ersetzen keine Membership.
 */
export function resolveCommandContextForSocket(
  data: {
    commandId?: unknown;
    requestId?: unknown;
    protocolVersion?: unknown;
    expectedRevision?: unknown;
    stateVersion?: unknown;
    roomCode?: unknown;
  } | null | undefined,
  socket: { data: Record<string, unknown> } & {
    // Minimaler Socket-Stub für Tests; echtes socket.io-Socket erfüllt das.
  },
): CommandContextResult {
  const versionError = checkCommandProtocolVersion(data?.protocolVersion);
  if (versionError) return { ok: false, error: versionError };
  // Presence is not absence: never strip malformed fields into Legacy mode.
  const checked = commandFields.safeParse(data ?? {});
  if (!checked.success) return { ok: false, error: 'INVALID_PAYLOAD' };
  if (!checked.data.commandId && !checked.data.requestId
    && (checked.data.stateVersion !== undefined || checked.data.expectedRevision !== undefined)) {
    return { ok: false, error: 'INVALID_PAYLOAD' };
  }

  // Alias conflicts are malformed input even before a socket joins a room.
  if (checked.data.commandId !== undefined && checked.data.requestId !== undefined && checked.data.commandId !== checked.data.requestId
    || checked.data.stateVersion !== undefined && checked.data.expectedRevision !== undefined && checked.data.stateVersion !== checked.data.expectedRevision) {
    return { ok: false, error: 'INVALID_PAYLOAD' };
  }

  // Serverseitige Identität (nie client-behauptet):
  const d = socket?.data ?? {};
  const roomId = typeof d.roomId === 'string' ? d.roomId : undefined;
  const rawRole = typeof d.role === 'string' ? d.role : undefined;
  const participationId = typeof d.participationId === 'string' ? d.participationId : undefined;
  if (!roomId || !rawRole) return { ok: false, error: 'NOT_IN_ROOM' };
  const identity = getSocketIdentityStub(socket);
  const actorId = participationId ?? identity?.participationId ?? roomId;

  // Audit PR14, 14-03: ALTE UND NEUE Feldbezeichnungen werden GEMEINSAM an
  // den validierten Resolver übergeben (nicht einer vor dem anderen
  // ausgewählt). Widersprüchliche Paare (commandId ≠ requestId,
  // stateVersion ≠ expectedRevision) und ungültige Werte (Länge, negatives
  // stateVersion, roomCode-Format) → null → INVALID_PAYLOAD, VOR jeder
  // Mutation. Der client-angegebene roomCode dient NUR der Envelope-
  // Validierung — Membership kommt weiterhin ausschließlich aus der
  // serverseitigen Socket-Identität.
  const rawRoomCode = typeof data?.roomCode === 'string' ? data.roomCode : '';
  let envelope: CommandEnvelope | undefined;
  const hasNewId = typeof data?.commandId === 'string' && data.commandId.length > 0;
  const hasOldId = typeof data?.requestId === 'string' && data.requestId.length > 0;
  const commandId = hasNewId ? data.commandId as string : hasOldId ? data.requestId as string : undefined;
  if (commandId) {
    const resolved: CommandEnvelope | null = resolveCommandEnvelope({
      commandId: hasNewId ? data.commandId as string : undefined,
      requestId: hasOldId ? data.requestId as string : undefined,
      protocolVersion: data?.protocolVersion === undefined ? undefined : resolveProtocolVersion(data?.protocolVersion),
      roomCode: rawRoomCode || undefined, // fehlend = undefined (optional im Envelope)
      stateVersion: typeof data?.stateVersion === 'number' ? data.stateVersion : undefined,
      expectedRevision: typeof data?.expectedRevision === 'number' ? data.expectedRevision : undefined,
      payload: data,
    });
    if (resolved === null) return { ok: false, error: 'INVALID_PAYLOAD' };
    envelope = resolved;
  }

  return {
    ok: true,
    ctx: {
      roomId,
      actorId,
      actorRole: rawRole,
      commandId,
      commandMode: Boolean(commandId),
      envelope,
    },
  };
}

// getSocketIdentity ist hier nur für den userId-Fallback; wir halten uns
// bewusst an socket.data (stabil, in den Handlers gesetzt).
function getSocketIdentityStub(socket: object): { participationId?: string } | null {
  try {
    return (getSocketIdentity as (s: unknown) => { participationId?: string } | null)(socket);
  } catch {
    return null;
  }
}

export { PROTOCOL_VERSION };
export { getSocketDataIdentity };
