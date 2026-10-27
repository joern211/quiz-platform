import { afterEach, expect, it } from 'vitest';
import { readMediaPreferences, saveMediaPreferences } from './mediaPreferences';
afterEach(() => localStorage.clear());
it('keeps filters per device and preserves the output preference when prejoin saves settings', () => {
  const prefs = readMediaPreferences(); prefs.audioDevice = 'mic-a'; prefs.outputDevice = 'speaker-b'; prefs.filtersByDevice['mic-a'] = { echoCancellation: false, noiseSuppression: true, autoGainControl: false }; prefs.filtersByDevice['mic-b'] = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };
  saveMediaPreferences(prefs); const reread = readMediaPreferences(); expect(reread.outputDevice).toBe('speaker-b'); expect(reread.filtersByDevice['mic-a'].echoCancellation).toBe(false); expect(reread.filtersByDevice['mic-b'].noiseSuppression).toBe(false);
});
it('rejects malformed stored device settings without requesting hardware', () => {
  localStorage.setItem('qp:media-devices:v1', JSON.stringify({ audioDevice: {}, outputDevice: 3, echoCancellation: 'false', filtersByDevice: { broken: { noiseSuppression: 'no' } } }));
  const prefs = readMediaPreferences(); expect(prefs.audioDevice).toBe(''); expect(prefs.outputDevice).toBe(''); expect(prefs.echoCancellation).toBe(true); expect(prefs.filtersByDevice.broken.noiseSuppression).toBe(true);
});
