import { z } from 'zod';
import { resolveCanonicalSlug, SetupBlueprintInputSchema, SetupBlueprintRefSchema, BlueprintGameSetupSchema, type SetupBlueprintView, type SetupBlueprintInput, type SetupBlueprintRef } from '@quiz/shared';
import { ContentError, requirePool, auditContent, type ContentDb, type ContentActor } from './core.js';

const systems: SetupBlueprintView[] = [
  { id: 'system:room-standard', scope: 'SYSTEM', kind: 'ROOM_TEMPLATE', gameSlug: null, name: 'Standardraum', revision: 1, favorite: false, configuration: { room: { allowViewers: true, cameraEnabled: false, lobbyChatEnabled: true }, preferredGamePresetIds: [] } },
  { id: 'system:room-private', scope: 'SYSTEM', kind: 'ROOM_TEMPLATE', gameSlug: null, name: 'Privater Spieleabend', revision: 1, favorite: false, configuration: { room: { isPublic: false, allowViewers: false, cameraEnabled: false }, preferredGamePresetIds: [] } },
];
export async function readSetupBlueprint(db: ContentDb, actor: ContentActor, id: string, revision?: number): Promise<SetupBlueprintView> {
  let result = systems.find(s => s.id === id);
  if (!result) {
    const row = await db.setupBlueprint.findFirst({ where: { id, ownerId: actor.userId, status: 'ACTIVE' } });
    if (!row) throw new ContentError('RESOURCE_NOT_ACCESSIBLE', 404);
    result = { ...rowInput(row), id, revision: row.revision, scope: 'PRIVATE' };
  }
  if (revision !== undefined && result.revision !== revision) throw new ContentError('REVISION_CONFLICT', 409);
  return result;
}
function rowInput(row: { kind: string; gameSlug: string | null; name: string; favorite: boolean; configurationJson: string }) {
  return SetupBlueprintInputSchema.parse({ kind: row.kind, gameSlug: row.gameSlug, name: row.name, favorite: row.favorite, configuration: JSON.parse(row.configurationJson) });
}
export async function setupBlueprintCatalog(db: ContentDb, actor: ContentActor, gameSlug: string) {
  const rows = await db.setupBlueprint.findMany({ where: { ownerId: actor.userId, status: 'ACTIVE', OR: [{ gameSlug }, { kind: 'ROOM_TEMPLATE' }] }, orderBy: [{ favorite: 'desc' }, { name: 'asc' }] });
  return [...systems, ...rows.map(row => ({ ...rowInput(row), id: row.id, revision: row.revision, scope: 'PRIVATE' as const }))];
}
export async function validateBlueprint(db: ContentDb, actor: ContentActor, input: SetupBlueprintInput) {
  if (input.kind === 'ROOM_TEMPLATE') {
    for (const id of input.configuration.preferredGamePresetIds) if ((await readSetupBlueprint(db, actor, id)).kind !== 'GAME_PRESET') throw new ContentError('INVALID_GAME_PRESET');
    return;
  }
  const setup = input.configuration.setup;
  if (input.gameSlug === 'wissensduell' && (setup.board1 || setup.board2) || input.gameSlug === 'jeopardy' && (setup.selectedQuestionIds?.length || setup.questionPoolId || setup.timerDuration)) throw new ContentError('PRESET_GAME_MISMATCH');
  if (setup.contentSelection) {
    for (const id of setup.contentSelection.poolIds) if ((await requirePool(db, id, actor)).gameSlug !== input.gameSlug) throw new ContentError('CONTENT_GAME_MISMATCH');
    if (setup.board1 || setup.board2 || setup.selectedQuestionIds?.length || setup.questionPoolId) throw new ContentError('AMBIGUOUS_CONTENT_SELECTION');
  }
  if (setup.selectedQuestionIds?.length && (new Set(setup.selectedQuestionIds).size !== setup.selectedQuestionIds.length || await db.geoQuestion.count({ where: { id: { in: setup.selectedQuestionIds }, enabled: true, pack: { gameSlug: { in: ['geo', 'wissensduell'] } } } }) !== setup.selectedQuestionIds.length)) throw new ContentError('CONTENT_NOT_READY');
  if (setup.questionPoolId && !await db.questionPack.findFirst({ where: { id: setup.questionPoolId, gameSlug: { in: ['geo', 'wissensduell'] } } })) throw new ContentError('CONTENT_NOT_READY');
}
export async function saveSetupBlueprint(db: ContentDb, actor: ContentActor, input: SetupBlueprintInput, ref?: SetupBlueprintRef) {
  await validateBlueprint(db, actor, input);
  if (ref) {
    const current = await readSetupBlueprint(db, actor, ref.id, ref.revision);
    if (current.scope === 'SYSTEM' || current.kind !== input.kind || current.gameSlug !== input.gameSlug) throw new ContentError('NOT_AUTHORIZED', 403);
  }
  const data = { kind: input.kind, gameSlug: input.gameSlug, name: input.name, favorite: input.favorite, configurationJson: JSON.stringify(input.configuration) };
  const row = ref ? await db.setupBlueprint.update({ where: { id: ref.id, revision: ref.revision }, data: { ...data, revision: { increment: 1 } } }) : await db.setupBlueprint.create({ data: { ownerId: actor.userId, ...data } });
  await auditContent(db, actor, 'SETUP_BLUEPRINT_SAVE', row.id, { kind: row.kind, revision: row.revision });
  return { blueprint: { ...input, id: row.id, revision: row.revision, scope: 'PRIVATE' as const } };
}
/** Recursively combine settings; arrays are complete replacements, not index merges. */
export function mergeSetupValues(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ContentError('INVALID_CONTENT');
    if (value === undefined) continue;
    const prior = out[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergeSetupValues(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior as Record<string, unknown> : {}, value as Record<string, unknown>) : value;
  }
  return out;
}
export async function prepareBlueprintRoom(db: ContentDb, actor: ContentActor, raw: Record<string, unknown>) {
  raw = z.record(z.unknown()).parse(raw);
  const gameRef = raw.gamePreset === undefined ? undefined : SetupBlueprintRefSchema.parse(raw.gamePreset);
  const roomRef = raw.roomTemplate === undefined ? undefined : SetupBlueprintRefSchema.parse(raw.roomTemplate);
  if (!gameRef && !roomRef) return { input: raw, provenance: null, refs: [] as SetupBlueprintRef[] };
  const game = gameRef ? await readSetupBlueprint(db, actor, gameRef.id, gameRef.revision) : null;
  const template = roomRef ? await readSetupBlueprint(db, actor, roomRef.id, roomRef.revision) : null;
  if (game && game.kind !== 'GAME_PRESET' || template && template.kind !== 'ROOM_TEMPLATE') throw new ContentError('INVALID_BLUEPRINT_KIND');
  const definition = raw.gameDefinitionId ? await db.gameDefinition.findUnique({ where: { id: String(raw.gameDefinitionId) } }) : null;
  if (game && resolveCanonicalSlug(definition?.slug ?? String(raw.gameSlug)) !== game.gameSlug) throw new ContentError('PRESET_GAME_MISMATCH');
  if (game) await validateBlueprint(db, actor, game);
  const templateConfig = template?.kind === 'ROOM_TEMPLATE' ? template.configuration : null;
  const presetConfig = game?.kind === 'GAME_PRESET' ? game.configuration : null;
  let explicit: Record<string, unknown> = raw.setupSnapshotJson as Record<string, unknown> ?? {};
  if (typeof raw.setupSnapshotJson === 'string') { try { explicit = z.record(z.unknown()).parse(JSON.parse(raw.setupSnapshotJson)); } catch { throw new ContentError('INVALID_CONTENT'); } }
  const presetSetup = presetConfig?.setup ?? {};
  const setup: Record<string, unknown> = game ? BlueprintGameSetupSchema.parse(mergeSetupValues(presetSetup, explicit)) : mergeSetupValues({}, explicit);
  const selection = setup.contentSelection as Record<string, unknown> | undefined;
  if (templateConfig?.language && selection && !presetSetup.contentSelection?.language && !(explicit.contentSelection as Record<string, unknown> | undefined)?.language) selection.language = templateConfig.language;
  const input = { ...templateConfig?.room, ...presetConfig?.room, ...raw, setupSnapshotJson: setup };
  return { input, refs: [gameRef, roomRef].filter((v): v is SetupBlueprintRef => !!v), provenance: { gamePreset: gameRef ?? null, roomTemplate: roomRef ?? null, presetSetup, explicitSetup: explicit } };
}
