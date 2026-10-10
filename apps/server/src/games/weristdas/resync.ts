import type { GameRole } from '../core/access.js';
import { buildSignedMediaUrl } from '../../media/signedUrl.js';
import { normalizeRound, type WerIstDasSetup } from './contracts.js';
import type { WerIstDasState } from './state.js';

/**
 * Rollenbasierte Projektion (Regelwerk §5.15/§5.20, §10.7, §15.3).
 *
 * Vor Reveal erhalten Player/Viewer/Display AUSSCHLIESSLICH das freigegebene
 * Spielbild (v2: Composite, v1: das vorbereitete Bild) — als **Signed URL**
 * (audience "game"), denn private Assets sind über die rohe ID nicht mehr
 * ladbar (PR11 Medienrechte). Original-IDs/-URLs und Namen erscheinen in der
 * Projektion NIEMALS vor Reveal und nie für Player/Viewer/Display.
 *
 * Nach Reveal: Namen + Beschreibung werden öffentlich (das ausdrücklich
 * Freigegebene). Die Originale bleiben server/hostsecret und erscheinen nur
 * in der Host-Projektion als Signed-URLs (audience "host", zusätzlich mit
 * Host-Session prüfbar) — damit die Reveal-Ausgabe nachvollziehbar bleibt.
 *
 * `imageAssetId` (rohe ID des freigegebenen Spielbilds) bleibt aus
 * Kompatibilität Teil der Projektion — das Spielbild ist kein Secret.
 */
export function projectWerIstDas(
  state: WerIstDasState, setup: WerIstDasSetup, role: GameRole, participationId?: string,
) {
  const round = setup.rounds[state.roundIndex];
  const norm = normalizeRound(round);
  const solution = role === 'MODERATOR' || state.revealed;
  return {
    phase: state.phase,
    roundIndex: state.roundIndex,
    roundCount: state.roundCount,
    roundId: round.id,
    // Freigegebenes Spielbild: rohe ID (Identität) + Signed URL (Rendering).
    imageAssetId: norm.imageUrlAssetId,
    gameImageUrl: buildSignedMediaUrl({ assetId: norm.imageUrlAssetId, audience: 'game' }),
    scores: state.scores,
    playerNames: state.playerNames,
    buzzerOpen: state.buzzer.open,
    winnerId: state.buzzer.winnerId,
    winnerName: state.buzzer.winnerId ? state.playerNames[state.buzzer.winnerId] : null,
    hintActive: state.hintActive,
    excludedPlayerIds: role === 'MODERATOR' ? state.buzzer.excludedPlayerIds : undefined,
    excluded: role === 'PLAYER' ? state.buzzer.excludedPlayerIds.includes(participationId ?? '') : undefined,
    solvedBy: state.solvedBy,
    lastDelta: state.lastDelta,
    revealed: state.revealed,
    // Namen/Alternativen/Beschreibung: erst bei Reveal (alle) bzw. immer Host.
    person1: solution ? norm.personA : undefined,
    person2: solution ? norm.personB : undefined,
    aliases1: role === 'MODERATOR' ? norm.aliasesA : undefined,
    aliases2: role === 'MODERATOR' ? norm.aliasesB : undefined,
    description: solution ? norm.description : undefined,
    // v2: Original-Assets NUR in der Host-Projektion (Signed host-URLs).
    // Niemals als rohe IDs oder game-URLs an Player/Viewer/Display.
    hostImageUrls: role === 'MODERATOR' && norm.version === 2
      ? norm.secretAssetIds.map(assetId => buildSignedMediaUrl({ assetId, audience: 'host' }))
      : undefined,
  };
}
