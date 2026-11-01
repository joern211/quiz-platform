// ============================================================
// Persönliche Darstellung: Theme (Hell/Dunkel) + Akzentfamilie
//
// Reichweite: ausschließlich dieser Browser (localStorage). Es gibt
// keine Account-Synchronisierung; die Wahl folgt nicht auf andere
// Geräte und wirkt nie raumweit. Werte werden beim Lesen validiert,
// unbekannte/alte/defekte Werte fallen kontrolliert auf den Standard
// zurück, Speicherfehler (blockiertes Storage, Quota) werden
// geschluckt – die Darstellung funktioniert dann nur bis zum Reload.
//
// WICHTIG: apps/web/index.html enthält eine kleine, inhaltsgleiche
// Vorab-Anwendung (vor React), damit beim Laden kein falsches Theme
// aufblitzt. Änderungen an Schlüssel/Format dort mitziehen.
// ============================================================

export type Theme = 'dark' | 'light';

/**
 * Vordefinierte, abgestimmte Akzentfamilien (keine freie Hex-Eingabe).
 * `swatch` = Akzentfarbe je Theme, identisch mit tokens.css (per Test geprüft);
 * nur für die Vorschau in den Einstellungen.
 */
export const ACCENTS = [
  { id: 'lila', label: 'Lila', swatch: { dark: '#e1b0f4', light: '#763a91' } },
  { id: 'blau', label: 'Blau', swatch: { dark: '#a7c8ff', light: '#2456b5' } },
  { id: 'tuerkis', label: 'Türkis', swatch: { dark: '#7fdad3', light: '#0b6b69' } },
  { id: 'gruen', label: 'Grün', swatch: { dark: '#addf9c', light: '#2f6a27' } },
  { id: 'orange', label: 'Orange', swatch: { dark: '#ffbf87', light: '#9a4708' } },
  { id: 'rosa', label: 'Rosa', swatch: { dark: '#ffadd2', light: '#a5306a' } },
] as const;

export type Accent = (typeof ACCENTS)[number]['id'];

export interface Appearance {
  theme: Theme;
  accent: Accent;
}

export const APPEARANCE_KEY = 'quiz-appearance';
/** Bis v0.3 einziger Schlüssel ('dark' | 'light'); wird gelesen und mitgeschrieben. */
export const LEGACY_THEME_KEY = 'quiz-theme';
export const APPEARANCE_VERSION = 1;
export const DEFAULT_ACCENT: Accent = 'lila';
export const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', accent: DEFAULT_ACCENT };

/** Hintergrundfarbe je Theme für <meta name="theme-color"> (Browserleiste). */
export const THEME_BACKGROUND: Record<Theme, string> = { dark: '#11101b', light: '#faf5fc' };

export function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

export function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && ACCENTS.some((a) => a.id === value);
}

export function accentLabel(accent: Accent): string {
  return ACCENTS.find((a) => a.id === accent)?.label ?? accent;
}

/**
 * Validiert gespeicherte Rohwerte. Jede Achse fällt einzeln zurück:
 * ein kaputter Akzent setzt nicht das Theme zurück und umgekehrt.
 */
export function parseAppearance(raw: string | null, legacyTheme: string | null = null): Appearance {
  let theme: Theme = isTheme(legacyTheme) ? legacyTheme : DEFAULT_APPEARANCE.theme;
  let accent: Accent = DEFAULT_ACCENT;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && (parsed as { v?: unknown }).v === APPEARANCE_VERSION) {
        const value = parsed as { theme?: unknown; accent?: unknown };
        if (isTheme(value.theme)) theme = value.theme;
        if (isAccent(value.accent)) accent = value.accent;
      }
    } catch {
      /* defekter JSON-Wert → Standard bzw. Legacy-Theme */
    }
  }
  return { theme, accent };
}

export function serializeAppearance(appearance: Appearance): string {
  return JSON.stringify({ v: APPEARANCE_VERSION, theme: appearance.theme, accent: appearance.accent });
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // Zugriff selbst kann werfen (z. B. blockierte Website-Daten)
  }
}

export function readAppearance(): Appearance {
  const store = storage();
  if (!store) return { ...DEFAULT_APPEARANCE };
  try {
    return parseAppearance(store.getItem(APPEARANCE_KEY), store.getItem(LEGACY_THEME_KEY));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/** Speichert nur bei Änderung (verhindert Storage-Echo zwischen Tabs). Liefert false bei Speicherfehler. */
export function writeAppearance(appearance: Appearance): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const next = serializeAppearance(appearance);
    if (store.getItem(APPEARANCE_KEY) !== next) store.setItem(APPEARANCE_KEY, next);
    if (store.getItem(LEGACY_THEME_KEY) !== appearance.theme) store.setItem(LEGACY_THEME_KEY, appearance.theme);
    return true;
  } catch {
    return false;
  }
}

/** Setzt die Darstellung am Dokument. Ändert nur Attribute – kein Remount, keine Netzwerkaktion. */
export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): void {
  if (root.getAttribute('data-theme') !== appearance.theme) root.setAttribute('data-theme', appearance.theme);
  if (root.getAttribute('data-accent') !== appearance.accent) root.setAttribute('data-accent', appearance.accent);
  const meta = root.ownerDocument?.querySelector('meta[name="theme-color"]');
  if (meta && meta.getAttribute('content') !== THEME_BACKGROUND[appearance.theme]) {
    meta.setAttribute('content', THEME_BACKGROUND[appearance.theme]);
  }
}

export function sameAppearance(a: Appearance, b: Appearance): boolean {
  return a.theme === b.theme && a.accent === b.accent;
}
