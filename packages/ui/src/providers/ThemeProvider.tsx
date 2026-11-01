// ============================================================
// ThemeProvider – Theme (Hell/Dunkel) und persönliche Akzentfarbe
//
// Zwei unabhängige Einstellungen, zentral verwaltet. Ein Wechsel
// setzt nur Attribute am <html>-Element; der Provider rendert seine
// Kinder nie neu ein (kein key, keine bedingte Struktur), damit
// Socket-/Medien-/Spielzustand, Fokus und Eingaben erhalten bleiben.
// ============================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  APPEARANCE_KEY,
  DEFAULT_ACCENT,
  LEGACY_THEME_KEY,
  applyAppearance,
  readAppearance,
  sameAppearance,
  writeAppearance,
  type Accent,
  type Appearance,
  type Theme,
} from './appearance';

interface ThemeContextType {
  theme: Theme;
  accent: Accent;
  /** false, wenn der Browser das Speichern verweigert (gilt dann nur bis zum Neuladen). */
  persisted: boolean;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setAccent: (accent: Accent) => void;
  resetAccent: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance());
  const [persisted, setPersisted] = useState(true);

  // Anwenden + speichern (nur bei echter Änderung, kein Echo)
  useEffect(() => {
    if (typeof document !== 'undefined') applyAppearance(appearance);
    setPersisted(writeAppearance(appearance));
  }, [appearance]);

  // Andere Tabs desselben Browsers übernehmen die Wahl
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== APPEARANCE_KEY && event.key !== LEGACY_THEME_KEY) return;
      const next = readAppearance();
      setAppearance((current) => (sameAppearance(current, next) ? current : next));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((theme: Theme) => {
    setAppearance((current) => (current.theme === theme ? current : { ...current, theme }));
  }, []);
  const toggleTheme = useCallback(() => {
    setAppearance((current) => ({ ...current, theme: current.theme === 'dark' ? 'light' : 'dark' }));
  }, []);
  const setAccent = useCallback((accent: Accent) => {
    setAppearance((current) => (current.accent === accent ? current : { ...current, accent }));
  }, []);
  const resetAccent = useCallback(() => setAccent(DEFAULT_ACCENT), [setAccent]);

  const value = useMemo<ThemeContextType>(() => ({
    theme: appearance.theme,
    accent: appearance.accent,
    persisted,
    toggleTheme,
    setTheme,
    setAccent,
    resetAccent,
  }), [appearance, persisted, toggleTheme, setTheme, setAccent, resetAccent]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
