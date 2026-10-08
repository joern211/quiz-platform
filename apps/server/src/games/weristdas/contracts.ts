import { z } from 'zod';

export const WerIstDasPhase = {
  ROUND_READY: 'ROUND_READY',
  BUZZ_OPEN: 'BUZZ_OPEN',
  ANSWERING: 'ANSWERING',
  REVEAL: 'REVEAL',
  GAME_END: 'GAME_END',
} as const;

export type WerIstDasPhase = (typeof WerIstDasPhase)[keyof typeof WerIstDasPhase];

/**
 * Engine-Version für „Wer ist das?“ (Regelwerk §5.22).
 * v2: Composite-Setup (zwei Originale + Spielbild), rollenbasierte
 * Projektion mit Signed-URLs, Reveal-Endmaskierung.
 */
export const WER_IST_DAS_ENGINE_VERSION = 2;

/** Setup-Schema-Versionen (Regelwerk §5.23/§5.24). */
export const WER_IST_DAS_SETUP_VERSIONS = { v1: 1, v2: 2 } as const;

/**
 * Engine-State-Versionen, die dieser Reader EXAKT und sicher versteht
 * (Regelwerk §5.22, PR11-Nacharbeit D).
 *
 * WICHTIGE ENTSCHEIDUNG (D): v1 (historisch, ein vorbereitetes Bild) und v2
 * (Fusion) erzeugen die GLEICHE State-Form `WerIstDasState` — die
 * Versions-Differenz liegt NICHT im Engine-State, sondern im
 * Setup-Rundenformat (ein Bild vs. zwei Originale + Composite), das
 * `normalizeRound` version-agnostisch über die Union liest. Deshalb unterstützt
 * EIN gemeinsamer Reader beide Versionen exakt. Das wird nicht behauptet,
 * sondern durch den echten Prozess-Restart-Test (v1- UND v2-Raum) belegt.
 *
 * Eine HÖHERE oder unbekannte Version (z.B. 3 aus einer zukünftigen Engine,
 * die andere State-Felder haben könnte) wird NICHT gedeutet → kontrollierter
 * Fehler statt falschem State (D: "kontrolliertes Pausieren/Fehler statt
 * falschem State").
 */
export const SUPPORTED_ENGINE_VERSIONS: readonly number[] = [1, WER_IST_DAS_ENGINE_VERSION];
export function isSupportedEngineVersion(version: number): boolean {
  return SUPPORTED_ENGINE_VERSIONS.includes(version);
}

const name = z.string().trim().min(1).max(150);
const aliases = z.array(z.string().trim().min(1).max(150)).max(20).optional();
const roundId = z.string().min(1).max(100);
const uuid = z.string().uuid();
const description = z.string().max(1000).optional();

// ------------------------------------------------------------
// v1-Runde (MVP): ein vorbereitetes fertiges Bild + zwei Namen.
// Bleibt lauffähig; wird NUR gelesen, nicht mehr neu erzeugt.
// ------------------------------------------------------------
export const WerIstDasRoundV1Schema = z.object({
  id: roundId,
  imageAssetId: uuid,
  person1: name,
  person2: name,
  aliases1: aliases,
  aliases2: aliases,
  description,
  // Explizit 1 für neu erzeugte v1-Runden; bei historischen Snapshots darf
  // das Feld fehlen (Default 1).
  setupVersion: z.literal(1).optional(),
});
export type WerIstDasRoundV1 = z.infer<typeof WerIstDasRoundV1Schema>;

// ------------------------------------------------------------
// v2-Runde (Fusion, Regelwerk §15.3): zwei Originalbilder + von der
// Website erzeugtes Composite-Spielbild. Namen sind server/hostsecret.
// ------------------------------------------------------------
export const WerIstDasRoundV2Schema = z.object({
  id: roundId,
  personAImageAssetId: uuid,
  personBImageAssetId: uuid,
  gameImageAssetId: uuid,
  personAName: name,
  personBName: name,
  aliasesA: aliases,
  aliasesB: aliases,
  description,
  setupVersion: z.literal(2).optional(),
});
export type WerIstDasRoundV2 = z.infer<typeof WerIstDasRoundV2Schema>;

// ------------------------------------------------------------
// Versionierte Runde: Reader akzeptiert alte (v1) und neue (v2) Snapshots
// gemischt — ohne stille Umschreibung (Regelwerk §5.23). Die beiden
// Formen sind strukturell disjunkt (unterschiedliche Asset-Felder),
// daher ist die Union eindeutig.
// ------------------------------------------------------------
export const WerIstDasRoundSchema = z.union([
  WerIstDasRoundV1Schema,
  WerIstDasRoundV2Schema,
]);
export type WerIstDasRound = z.infer<typeof WerIstDasRoundSchema>;

export const WerIstDasSetupSchema = z.object({
  // 1 = nur v1-Runden (historisch), 2 = v1+v2 möglich. Default 1 für alte Daten.
  setupSchemaVersion: z.union([z.literal(1), z.literal(2)]).optional().default(1),
  rounds: z.array(WerIstDasRoundSchema).min(1).max(50),
});
export type WerIstDasSetup = z.infer<typeof WerIstDasSetupSchema>;

export const WerIstDasJudgeSchema = z.object({
  result: z.enum(['BOTH_CORRECT', 'ONE_CORRECT', 'WRONG']),
});
export type WerIstDasJudgeResult = z.infer<typeof WerIstDasJudgeSchema>;

/** true, wenn die Runde in der v2-Form (Fusion) vorliegt. */
export function isV2Round(round: WerIstDasRound): round is WerIstDasRoundV2 {
  const { setupVersion, gameImageAssetId } = round as Partial<WerIstDasRoundV1> & Partial<WerIstDasRoundV2>;
  return setupVersion === 2 || typeof gameImageAssetId === 'string';
}

/**
 * Normalisiert eine Runde (v1 oder v2) auf eine interne, version-agnostische
 * Repräsentation, damit Engine/State/Projection einen einzigen Pfad haben:
 *
 *   imageUrlAssetId → das FREIGEGEBENE Spielbild (v2: Composite, v1: Bild).
 *   secretAssetIds  → die Original-Assets (v2), NIEMALS an Player/Viewer/
 *                     Display vor Reveal — nur Host-Kontext über host-URLs.
 *   personA/personB → die Namen (server/hostsecret).
 */
export interface NormalizedRound {
  id: string;
  version: 1 | 2;
  imageUrlAssetId: string;
  secretAssetIds: string[];
  personA: string;
  personB: string;
  aliasesA?: string[];
  aliasesB?: string[];
  description?: string;
}

export function normalizeRound(round: WerIstDasRound): NormalizedRound {
  if (isV2Round(round)) {
    return {
      id: round.id,
      version: 2,
      imageUrlAssetId: round.gameImageAssetId,
      secretAssetIds: [round.personAImageAssetId, round.personBImageAssetId],
      personA: round.personAName,
      personB: round.personBName,
      aliasesA: round.aliasesA,
      aliasesB: round.aliasesB,
      description: round.description,
    };
  }
  const v1 = round as WerIstDasRoundV1;
  return {
    id: v1.id,
    version: 1,
    imageUrlAssetId: v1.imageAssetId,
    secretAssetIds: [],
    personA: v1.person1,
    personB: v1.person2,
    aliasesA: v1.aliases1,
    aliasesB: v1.aliases2,
    description: v1.description,
  };
}

export const WER_IST_DAS_EVENTS = {
  OPEN: 'weristdas:buzzer:open',
  BUZZ: 'weristdas:buzz',
  JUDGE: 'weristdas:judge',
  HINT: 'weristdas:hint',
  REVEAL: 'weristdas:reveal',
  NEXT: 'weristdas:next',
  RESYNC: 'weristdas:resync',
  UPDATE: 'weristdas:update',
} as const;
