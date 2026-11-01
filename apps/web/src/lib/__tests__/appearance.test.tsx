// Persönliche Darstellung: Speicherung, Validierung, Kontrast und Isolation
import { beforeEach, describe, expect, it, vi } from 'vitest';
// gegenüber Spielzustand (kein Remount, keine Commands, Eingaben bleiben).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useEffect, useRef } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ACCENTS, APPEARANCE_KEY, LEGACY_THEME_KEY, ThemeProvider, parseAppearance, readAppearance,
  serializeAppearance, useTheme, writeAppearance,
} from '@quiz/ui';
import { AppearanceSettings } from '../../components/AppearanceSettings';

const tokens = readFileSync(resolve(__dirname, '../../../../../packages/ui/src/styles/tokens.css'), 'utf8');
const indexHtml = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');

// ── Kontrast (WCAG relative luminance) ──
const lum = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Liest die Variablen eines exakt angegebenen Selektors aus tokens.css. */
function block(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(tokens);
  if (!match) throw new Error(`Selektor fehlt: ${selector}`);
  return Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}
const base = { dark: block(':root[data-theme="dark"]'), light: block(':root[data-theme="light"]') };
const accentBlock = (theme: 'dark' | 'light', id: string) => block(theme === 'dark' ? `:root[data-accent="${id}"]` : `:root[data-theme="light"][data-accent="${id}"]`);

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-theme'); document.documentElement.removeAttribute('data-accent'); });

describe('Präferenz lesen/speichern', () => {
  it('nutzt Midnight dunkel + Lila ohne gespeicherte Präferenz', () => {
    expect(readAppearance()).toEqual({ theme: 'dark', accent: 'lila' });
  });
  it('übernimmt den bisherigen Theme-Wert (quiz-theme) und setzt den Akzent auf Standard', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'light');
    expect(readAppearance()).toEqual({ theme: 'light', accent: 'lila' });
  });
  it('führt defekte, alte und unbekannte Werte je Achse kontrolliert auf Standard zurück', () => {
    expect(parseAppearance('{kaputt', 'light')).toEqual({ theme: 'light', accent: 'lila' });
    expect(parseAppearance(JSON.stringify({ v: 1, theme: 'sepia', accent: 'blau' }))).toEqual({ theme: 'dark', accent: 'blau' });
    expect(parseAppearance(JSON.stringify({ v: 1, theme: 'light', accent: '#ff00ff' }))).toEqual({ theme: 'light', accent: 'lila' });
    expect(parseAppearance(JSON.stringify({ v: 99, theme: 'light', accent: 'rosa' }))).toEqual({ theme: 'dark', accent: 'lila' });
    expect(parseAppearance('null')).toEqual({ theme: 'dark', accent: 'lila' });
  });
  it('schreibt nur bei Änderung (kein Storage-Echo zwischen Tabs)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    expect(writeAppearance({ theme: 'light', accent: 'gruen' })).toBe(true);
    const writes = spy.mock.calls.length;
    writeAppearance({ theme: 'light', accent: 'gruen' });
    expect(spy.mock.calls.length).toBe(writes);
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe(serializeAppearance({ theme: 'light', accent: 'gruen' }));
    spy.mockRestore();
  });
  it('überlebt blockierten Speicher: Lesen liefert Standard, Schreiben meldet false statt zu werfen', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    expect(readAppearance()).toEqual({ theme: 'dark', accent: 'lila' });
    expect(writeAppearance({ theme: 'light', accent: 'rosa' })).toBe(false);
    get.mockRestore(); set.mockRestore();
  });
});

describe('Palette (tokens.css)', () => {
  it('enthält genau die sechs vereinbarten Familien mit Lila als Standard', () => {
    expect(ACCENTS.map(a => a.label)).toEqual(['Lila', 'Blau', 'Türkis', 'Grün', 'Orange', 'Rosa']);
    expect(accentBlock('dark', 'lila').accent).toBe(ACCENTS[0].swatch.dark);
    expect(accentBlock('light', 'lila').accent).toBe(ACCENTS[0].swatch.light);
  });
  it.each(ACCENTS.flatMap(a => (['dark', 'light'] as const).map(theme => [a.id, theme] as const)))('%s/%s: Vorschau = Token und Kontraste erfüllen das Ziel', (id, theme) => {
    const t = accentBlock(theme, id), b = base[theme];
    expect(t.accent).toBe(ACCENTS.find(a => a.id === id)!.swatch[theme]);
    for (const surface of [b.bg, b.surface, b['surface-2']]) expect(ratio(t.accent, surface)).toBeGreaterThanOrEqual(4.5); // Akzenttext/Links/Fokus
    expect(ratio(t['on-accent'], t.accent)).toBeGreaterThanOrEqual(4.5); // Text auf Hauptaktion
    expect(ratio(t['on-accent'], t['accent-strong'])).toBeGreaterThanOrEqual(4.5); // Hover
    expect(ratio(b.fg, t['accent-tint'])).toBeGreaterThanOrEqual(4.5); // Text auf ausgewählter Fläche
    expect(ratio(t.accent, t['accent-tint'])).toBeGreaterThanOrEqual(3); // Auswahlrahmen auf Tint
  });
  it.each(['dark', 'light'] as const)('%s: Grund- und Statusfarben erfüllen das Kontrastziel', theme => {
    const b = base[theme];
    expect(ratio(b.fg, b.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(b.muted, b.surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(b.muted, b['surface-2'])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(b['border-strong'], b.surface)).toBeGreaterThanOrEqual(3);
    for (const [fg, bg] of [['ok', 'ok-bg'], ['warn', 'warn-bg'], ['danger', 'danger-bg'], ['on-danger', 'danger'], ['on-ok', 'ok']]) expect(ratio(b[fg], b[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it('index.html wendet dieselben Schlüssel, Version und Familien vor React an', () => {
    expect(indexHtml).toContain(`'${APPEARANCE_KEY}'`);
    expect(indexHtml).toContain(`'${LEGACY_THEME_KEY}'`);
    expect(indexHtml).toContain('v.v === 1');
    for (const a of ACCENTS) expect(indexHtml).toContain(`'${a.id}'`);
  });
});

// ── Provider: Wechsel ohne Remount / Commands, Tab-Synchronisierung ──
let mounts = 0;
function GameLike({ onEmit }: { onEmit: () => void }) {
  const once = useRef(false);
  useEffect(() => { mounts++; if (!once.current) { once.current = true; onEmit(); } }, [onEmit]);
  return <label>Antwortentwurf<input defaultValue="" /></label>;
}
function Controls() {
  const { setAccent, toggleTheme, theme, accent } = useTheme();
  return <><span data-testid="state">{theme}/{accent}</span><button onClick={toggleTheme}>Theme</button><button onClick={() => setAccent('orange')}>Orange</button></>;
}

describe('ThemeProvider im laufenden Spiel', () => {
  it('Theme- und Akzentwechsel remountet keine Spielfläche, löst keine Aktion aus und erhält Eingaben', async () => {
    mounts = 0; const emit = vi.fn();
    render(<ThemeProvider><Controls /><GameLike onEmit={emit} /></ThemeProvider>);
    const draft = screen.getByLabelText('Antwortentwurf');
    await userEvent.type(draft, 'Canberra');
    await userEvent.click(screen.getByText('Orange'));
    await userEvent.click(screen.getByText('Theme'));
    expect(document.documentElement.dataset).toMatchObject({ theme: 'light', accent: 'orange' });
    expect(screen.getByLabelText('Antwortentwurf')).toBe(draft);
    expect(draft).toHaveValue('Canberra');
    expect(mounts).toBe(1); expect(emit).toHaveBeenCalledTimes(1);
  });
  it('Themewechsel behält die gewählte Akzentfamilie', async () => {
    render(<ThemeProvider><Controls /></ThemeProvider>);
    await userEvent.click(screen.getByText('Orange'));
    await userEvent.click(screen.getByText('Theme'));
    await userEvent.click(screen.getByText('Theme'));
    expect(screen.getByTestId('state')).toHaveTextContent('dark/orange');
  });
  it('übernimmt Änderungen aus einem anderen Tab ohne Rückschreiben', () => {
    render(<ThemeProvider><Controls /></ThemeProvider>);
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    const value = serializeAppearance({ theme: 'light', accent: 'tuerkis' });
    localStorage.setItem(APPEARANCE_KEY, value); localStorage.setItem(LEGACY_THEME_KEY, 'light'); spy.mockClear();
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_KEY, newValue: value })); });
    expect(screen.getByTestId('state')).toHaveTextContent('light/tuerkis');
    expect(document.documentElement.dataset.accent).toBe('tuerkis');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('Darstellungsdialog', () => {
  it('zeigt Auswahl mit Namen und Textstatus, wendet sofort an, speichert und setzt zurück', async () => {
    const close = vi.fn();
    render(<ThemeProvider><AppearanceSettings open onClose={close} /></ThemeProvider>);
    expect(screen.getByRole('dialog', { name: 'Darstellung' })).toBeInTheDocument();
    const lila = screen.getByRole('radio', { name: /Lila \(Standard\)/ });
    expect(lila).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /Blau/ }));
    expect(screen.getByRole('radio', { name: /Blau.*Ausgewählt/ })).toBeChecked();
    expect(document.documentElement.dataset.accent).toBe('blau');
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toMatchObject({ accent: 'blau' });
    await userEvent.click(screen.getByRole('radio', { name: /Hell/ }));
    expect(document.documentElement.dataset).toMatchObject({ theme: 'light', accent: 'blau' });
    await userEvent.click(screen.getByRole('button', { name: /Auf Standard/ }));
    expect(document.documentElement.dataset.accent).toBe('lila');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).toHaveBeenCalled();
  });
  it('meldet ehrlich, wenn der Browser das Speichern verweigert', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    render(<ThemeProvider><AppearanceSettings open onClose={() => {}} /></ThemeProvider>);
    await userEvent.click(screen.getByRole('radio', { name: /Rosa/ }));
    expect(document.documentElement.dataset.accent).toBe('rosa');
    expect(screen.getByRole('status')).toHaveTextContent('nur bis zum Neuladen');
    set.mockRestore();
  });
});
