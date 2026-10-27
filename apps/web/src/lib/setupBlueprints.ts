import type { GamePresetConfiguration, BlueprintRoomSettings, SetupBlueprintRef, SetupBlueprintView } from '@quiz/shared';
export const ROOM_SETUP_DEFAULTS = { maxPlayers: 10, cameraEnabled: false, allowViewers: true, viewerRequiresPin: true, viewerLimit: 50, lobbyChatEnabled: true, isPublic: true };
export type BlueprintApplication = { gamePreset?: SetupBlueprintRef; roomTemplate?: SetupBlueprintRef; baseline: GamePresetConfiguration };
function diff(value: unknown, base: unknown): unknown {
  if (JSON.stringify(value) === JSON.stringify(base)) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => { const changed = diff(entry, base && typeof base === 'object' ? (base as Record<string, unknown>)[key] : undefined); return changed === undefined ? [] : [[key, changed]]; }));
  return value;
}
export function blueprintRoomInput(current: GamePresetConfiguration, application?: BlueprintApplication | null) {
  return application ? { ...(diff(current.room, application.baseline.room) as object), setupSnapshotJson: diff(current.setup, application.baseline.setup) ?? {}, gamePreset: application.gamePreset, roomTemplate: application.roomTemplate }
    : { ...current.room, setupSnapshotJson: current.setup };
}
export function blueprintConfiguration(current: GamePresetConfiguration, game: SetupBlueprintView | null, template: SetupBlueprintView | null) {
  const preset = game?.kind === 'GAME_PRESET' ? game.configuration : null, room = template?.kind === 'ROOM_TEMPLATE' ? template.configuration : null;
  const baseline: GamePresetConfiguration = { room: { ...ROOM_SETUP_DEFAULTS, ...room?.room, ...preset?.room }, setup: preset?.setup ?? {} };
  const configuration: GamePresetConfiguration = { ...baseline, setup: preset ? structuredClone(preset.setup) : structuredClone(current.setup) };
  if (!preset && room?.language && configuration.setup.contentSelection) configuration.setup.contentSelection.language = room.language;
  return { configuration, application: { gamePreset: game ? { id: game.id, revision: game.revision } : undefined, roomTemplate: template ? { id: template.id, revision: template.revision } : undefined, baseline } };
}

export function roomSettingsAfterPin(value: BlueprintRoomSettings, pin: string): BlueprintRoomSettings {
  if (!value.roomPolicy) return value;
  const ordinary = (mode: string) => mode === 'PUBLIC_JOIN' || mode === 'PIN_PROTECTED';
  return { ...value, roomPolicy: { ...value.roomPolicy,
    playerAccess: ordinary(value.roomPolicy.playerAccess) ? pin ? 'PIN_PROTECTED' : 'PUBLIC_JOIN' : value.roomPolicy.playerAccess,
    viewerAccess: ordinary(value.roomPolicy.viewerAccess) ? pin && value.viewerRequiresPin !== false ? 'PIN_PROTECTED' : 'PUBLIC_JOIN' : value.roomPolicy.viewerAccess,
  } };
}
