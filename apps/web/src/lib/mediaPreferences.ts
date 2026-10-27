export type MicrophoneFilters = { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
export type MediaPreferences = MicrophoneFilters & { audioDevice: string; videoDevice: string; outputDevice: string; filtersByDevice: Record<string, MicrophoneFilters> };
export const defaultFilters: MicrophoneFilters = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
export function readMediaPreferences(): MediaPreferences {
  let saved: Record<string, unknown> = {}; try { const data = JSON.parse(localStorage.getItem('qp:media-devices:v1') ?? '{}'); if (data && typeof data === 'object') saved = data; } catch { /* defaults */ }
  const filter = (value: unknown): MicrophoneFilters => { const data = value && typeof value === 'object' ? value as Record<string, unknown> : {}; return Object.fromEntries(Object.entries(defaultFilters).map(([key, fallback]) => [key, typeof data[key] === 'boolean' ? data[key] : fallback])) as MicrophoneFilters; };
  const filtersByDevice: Record<string, MicrophoneFilters> = Object.create(null);
  if (saved.filtersByDevice && typeof saved.filtersByDevice === 'object') for (const [id, value] of Object.entries(saved.filtersByDevice).slice(0, 50)) filtersByDevice[id] = filter(value);
  return { ...filter(saved), audioDevice: typeof saved.audioDevice === 'string' ? saved.audioDevice : '', videoDevice: typeof saved.videoDevice === 'string' ? saved.videoDevice : '', outputDevice: typeof saved.outputDevice === 'string' ? saved.outputDevice : '', filtersByDevice };
}
export function saveMediaPreferences(value: MediaPreferences) { try { localStorage.setItem('qp:media-devices:v1', JSON.stringify(value)); } catch { /* private mode still permits capture */ } }
