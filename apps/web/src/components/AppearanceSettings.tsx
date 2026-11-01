// ============================================================
// Persönliche Darstellung (Dialog aus der oberen Navigation)
// Hell/Dunkel + Akzentfarbe. Wirkt sofort, nur in diesem Browser.
// Öffnen/Schließen löst keine Navigation, keine Socket-Commands und
// kein Neuladen aus; der Dialog liegt per Portal außerhalb des Spielbaums.
// ============================================================

import { Modal, Button, ACCENTS, DEFAULT_ACCENT, accentLabel, useTheme, type Accent, type Theme } from '@quiz/ui';
import styles from './AppearanceSettings.module.css';

const THEMES: Array<{ id: Theme; label: string; hint: string }> = [
  { id: 'dark', label: 'Dunkel', hint: 'Midnight-Bühne' },
  { id: 'light', label: 'Hell', hint: 'Helle Variante' },
];

export function AppearanceSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme, accent, persisted, setTheme, setAccent, resetAccent } = useTheme();

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Darstellung"
      description="Gilt nur für dich in diesem Browser – nicht für den Raum und nicht für andere Geräte."
      footer={<Button onClick={onClose}>Fertig</Button>}
    >
      <fieldset className={styles.group}>
        <legend className={styles.legend}>Modus</legend>
        <div className={styles.themeGrid}>
          {THEMES.map((option) => (
            <label key={option.id} className={styles.themeOption} data-selected={theme === option.id || undefined}>
              <input
                type="radio"
                name="appearance-theme"
                value={option.id}
                checked={theme === option.id}
                onChange={() => setTheme(option.id)}
                className={styles.radio}
              />
              <span className={styles.themePreview} data-preview-theme={option.id} aria-hidden="true">
                <span /><span /><span />
              </span>
              <span className={styles.optionText}>
                <strong>{option.label}</strong>
                <small>{theme === option.id ? 'Ausgewählt' : option.hint}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>Akzentfarbe</legend>
        <p className={styles.help}>Färbt Hauptaktionen, Auswahl und Fokus. Erfolg, Warnung, Fehler und Teamfarben bleiben unverändert.</p>
        <div className={styles.accentGrid}>
          {ACCENTS.map((option) => {
            const selected = accent === option.id;
            return (
              <label key={option.id} className={styles.accentOption} data-selected={selected || undefined}>
                <input
                  type="radio"
                  name="appearance-accent"
                  value={option.id}
                  checked={selected}
                  onChange={() => setAccent(option.id as Accent)}
                  className={styles.radio}
                />
                <span className={styles.swatch} style={{ background: option.swatch[theme] }} aria-hidden="true">
                  {selected && (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
                  )}
                </span>
                <span className={styles.optionText}>
                  <strong>{option.label}{option.id === DEFAULT_ACCENT ? ' (Standard)' : ''}</strong>
                  <small>{selected ? 'Ausgewählt' : ' '}</small>
                </span>
              </label>
            );
          })}
        </div>
        <div className={styles.previewRow} aria-label={`Vorschau: ${accentLabel(accent)}`} role="group">
          <span className={styles.previewPrimary}>Hauptaktion</span>
          <span className={styles.previewSelected}>Ausgewählt</span>
          <span className={styles.previewLink}>Link</span>
        </div>
        <Button variant="ghost" size="sm" onClick={resetAccent} disabled={accent === DEFAULT_ACCENT}>
          Auf Standard (Lila) zurücksetzen
        </Button>
      </fieldset>

      {!persisted && (
        <p className="notice notice--warn" role="status">
          Dein Browser erlaubt kein Speichern. Die Auswahl gilt nur bis zum Neuladen der Seite.
        </p>
      )}
    </Modal>
  );
}
