import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BlueprintRoomSettingsSchema, getGameManifest, resolveCanonicalSlug, type BlueprintRoomSettings, type GamePresetConfiguration } from '@quiz/shared';
import { ContentPoolPicker, contentSelectionPayload, DEFAULT_CONTENT_OPTIONS, type ContentSelectionOptions } from '../components/ContentPoolPicker';
import { SetupBlueprints } from '../components/SetupBlueprints';
import { SetupRoomRules } from '../components/SetupRoomRules';
import { blueprintRoomInput, ROOM_SETUP_DEFAULTS, roomSettingsAfterPin, type BlueprintApplication } from '../lib/setupBlueprints';
import styles from './ContentPage.module.css';

const steps = ['Spiel', 'Pools und Themen', 'Difficulty', 'Fragen und Runden', 'Zentrale Optionen', 'Teams und Spieler', 'Prüfen und erstellen'];
export const suggestedQuickCount = (game: string, players: number) => game === 'jeopardy' ? 5 : Math.min(30, Math.max(5, players * 2));
export function QuickSetupPage() {
  const { gameSlug = 'wissensduell' } = useParams(), slug = resolveCanonicalSlug(gameSlug) ?? gameSlug;
  return slug === 'wissensduell' || slug === 'jeopardy' ? <QuickSetupFlow key={slug} gameSlug={slug} />
    : <section className={styles.page}><h1>Spiel vorbereiten</h1><p>Dieses Spiel benötigt seine eigene Vorbereitung.</p><Link to={`/moderator/vorbereitung/${slug}`}>Zur Spielvorbereitung</Link></section>;
}
function QuickSetupFlow({ gameSlug }: { gameSlug: 'wissensduell' | 'jeopardy' }) {
  const navigate = useNavigate(), [step, setStep] = useState(0), [pools, setPools] = useState<string[]>([]), [options, setOptions] = useState<ContentSelectionOptions>(DEFAULT_CONTENT_OPTIONS);
  const [players, setPlayers] = useState(4), [count, setCount] = useState(() => suggestedQuickCount(gameSlug, 4)), [timer, setTimer] = useState(20);
  const [room, setRoom] = useState<BlueprintRoomSettings>(ROOM_SETUP_DEFAULTS), [application, setApplication] = useState<BlueprintApplication | null>(null);
  const [name, setName] = useState(''), [pin, setPin] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('');
  const touchedCount = useRef(false), intent = useRef<string | null>(null);
  const changed = () => { intent.current = null; setError(''); };
  const actualCount = options.mode === 'MANUAL' ? options.itemIds?.length ?? 0 : options.poolCounts ? Object.values(options.poolCounts).reduce((sum, n) => sum + n, 0) : count;
  const maximum = getGameManifest(gameSlug)?.maxPlayers ?? 10;
  const configuration = (): GamePresetConfiguration => ({ room: { ...room, maxPlayers: players }, setup: {
    ...(gameSlug === 'wissensduell' ? { questionCount: actualCount, timerDuration: timer } : {}),
    ...(pools.length ? { contentSelection: contentSelectionPayload(pools, actualCount, options) } : {}),
  } });
  const validate = () => {
    if (!pools.length) return 'Wähle mindestens einen Fragenpool. Für die manuelle Boardvorbereitung nutze die erweiterte Spielvorbereitung.';
    try { configuration(); BlueprintRoomSettingsSchema.parse({ ...room, maxPlayers: players }); } catch (e) { return e instanceof Error ? e.message : 'Bitte die Auswahl prüfen.'; }
    if (actualCount < 1 || actualCount > 100) return 'Wähle zwischen 1 und 100 Fragen.';
    if (players < 2 || players > maximum) return `Dieses Spiel erlaubt 2 bis ${maximum} Spieler.`;
    if (pin && !/^\d{4,10}$/.test(pin)) return 'Die PIN muss aus 4 bis 10 Ziffern bestehen.';
    if (gameSlug === 'wissensduell' && (!Number.isInteger(timer) || timer < 1 || timer > 3600)) return 'Die Antwortzeit muss zwischen 1 und 3600 Sekunden liegen.';
    return '';
  };
  const next = () => {
    if (step === 1 && !pools.length) { setError('Wähle mindestens einen Fragenpool.'); return; }
    if (step >= 2) { const problem = validate(); if (problem) { setError(problem); return; } }
    setError(''); setStep(v => Math.min(6, v + 1));
  };
  const create = async () => {
    if (pending) return; const problem = validate(); if (problem) { setError(problem); return; }
    setPending(true); setError(''); intent.current ??= crypto.randomUUID();
    try {
      const response = await fetch('/api/v1/rooms', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameSlug, roomName: name.trim() || `${getGameManifest(gameSlug)?.name ?? gameSlug} Raum`, pin: pin || undefined, ...blueprintRoomInput(configuration(), application), idempotencyKey: intent.current }) });
      const json = await response.json(); if (!response.ok || !json.success || !json.data?.code) throw new Error(json.error?.message ?? 'Raum konnte nicht erstellt werden.');
      intent.current = null; navigate(`/moderator/raum/${json.data.code}/lobby`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Verbindung fehlgeschlagen.'); }
    finally { setPending(false); }
  };
  return <div className={styles.page}><h1>Schnellstart: {getGameManifest(gameSlug)?.name}</h1>
    <p>Schritt {step + 1} von 7 · {steps[step]}</p><ol className={styles.steps} aria-label="Vorbereitungsschritte">{steps.map((title, index) => <li key={title} aria-current={index === step ? 'step' : undefined}>{index + 1}. {title}</li>)}</ol>
    <fieldset className={styles.panel} disabled={pending}><legend>{steps[step]}</legend>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {step === 0 && <><label>Spiel<select aria-label="Spiel für Schnellstart" value={gameSlug} onChange={e => { if (window.confirm('Zum anderen Spiel wechseln und diese Vorbereitung zurücksetzen?')) navigate(`/moderator/schnellstart/${e.target.value}`); }}><option value="wissensduell">Wissensduell</option><option value="jeopardy">Jeopardy</option></select></label>
        <details><summary>Vorhandene Spiel- oder Raumvorlage verwenden</summary><SetupBlueprints gameSlug={gameSlug} current={configuration} onApply={(config, applied) => {
          if (applied.gamePreset && !config.setup.contentSelection) throw new Error('Dieses Preset nutzt eine manuelle Spielvorbereitung. Bitte in der erweiterten Vorbereitung laden.');
          changed(); setApplication(applied); setRoom(config.room); setPlayers(config.room.maxPlayers ?? 4); setTimer(config.setup.timerDuration ?? 20);
          const selection = config.setup.contentSelection; setPools(selection?.poolIds ?? []); setOptions(selection ? { ...DEFAULT_CONTENT_OPTIONS, ...selection, difficulty: selection.difficulty ?? '', category: selection.category ?? '' } : DEFAULT_CONTENT_OPTIONS);
          setCount(selection?.count ?? config.setup.questionCount ?? suggestedQuickCount(gameSlug, config.room.maxPlayers ?? 4)); touchedCount.current = !!applied.gamePreset;
        }} /></details></>}
      {step === 1 && <ContentPoolPicker view="pools" gameSlug={gameSlug} selected={pools} onChange={ids => { changed(); setPools(ids); }} options={options} onOptionsChange={value => { changed(); setOptions(value); }} count={actualCount} />}
      {step === 2 && <ContentPoolPicker view="filters" gameSlug={gameSlug} selected={pools} onChange={ids => { changed(); setPools(ids); }} options={options} onOptionsChange={value => { changed(); setOptions(value); }} count={actualCount} />}
      {step === 3 && <>{options.poolCounts || options.mode === 'MANUAL' ? <p>Die festgelegte Auswahl ergibt {actualCount} Fragen. Ändere Pool-Anzahlen oder den Verlauf im vorherigen Schritt.</p>
        : <label>Anzahl Fragen<input type="number" min={1} max={100} value={count} onChange={e => { changed(); touchedCount.current = true; setCount(Number(e.target.value)); }} /></label>}
        <p>{gameSlug === 'jeopardy' ? 'Die gewählten Fragen bilden ein Board. Kategorien und Punktwerte müssen zusammenpassen.' : 'Jede Frage bildet eine Runde. Die endgültige Auswahl wird beim Erstellen fest gespeichert.'}</p></>}
      {step === 4 && <><label>Raumname<input maxLength={100} value={name} onChange={e => { changed(); setName(e.target.value); }} /></label>
        <label>PIN (optional)<input inputMode="numeric" type="password" value={pin} maxLength={10} onChange={e => { const value = e.target.value; changed(); setPin(value); setRoom(old => roomSettingsAfterPin(old, value)); }} /></label>
        {gameSlug === 'wissensduell' && <label>Antwortzeit (Sekunden)<input type="number" min={1} max={3600} value={timer} onChange={e => { changed(); setTimer(Number(e.target.value)); }} /></label>}
        <label className={styles.check}><input type="checkbox" checked={room.allowViewers ?? true} onChange={e => { changed(); setRoom(old => ({ ...old, allowViewers: e.target.checked })); }} />Zuschauer erlauben</label>
        <p>Weitere Raumoptionen findest du im nächsten Schritt. PINs werden nicht in Vorlagen gespeichert.</p></>}
      {step === 5 && <><label>Maximale Spielerzahl<input type="number" min={2} max={maximum} value={players} onChange={e => { const value = Number(e.target.value); changed(); setPlayers(value); if (!touchedCount.current) setCount(suggestedQuickCount(gameSlug, value)); }} /></label>
        <p>Unveränderte Voreinstellungen passen sich an die Spielerzahl an. Deine selbst gewählte Fragenzahl bleibt erhalten.</p>
        <SetupRoomRules pinPresent={!!pin} value={room} onChange={value => { changed(); setRoom(value); }} /></>}
      {step === 6 && <section aria-label="Vorbereitungsübersicht"><h2>Bereit für die Lobby</h2><dl><dt>Spiel</dt><dd>{getGameManifest(gameSlug)?.name}</dd><dt>Pools</dt><dd>{pools.length}</dd><dt>Fragen</dt><dd>{actualCount}</dd><dt>Spielerlimit</dt><dd>{players}</dd><dt>Zuschauer</dt><dd>{room.allowViewers === false ? 'Aus' : 'Erlaubt'}</dd><dt>Host-Sicht</dt><dd>{options.visibility === 'BLIND_HOST' ? 'Blindmoderation' : 'Host-Vorschau'}</dd></dl>
        <p>Nach der Raumerstellung können die Spieler beitreten. Die Startprüfung und der Spielstart finden in der Lobby statt.</p>
      </section>}
      <div className={styles.actions}><button disabled={step === 0 || pending} onClick={() => { setError(''); setStep(v => Math.max(0, v - 1)); }}>Zurück</button>
        {step < 6 ? <button disabled={pending} onClick={next}>Weiter</button> : <button disabled={pending} onClick={() => void create()}>{pending ? 'Raum wird erstellt …' : 'Raum erstellen'}</button>}</div>
    </fieldset><p><Link to={`/moderator/vorbereitung/${gameSlug}`}>Erweiterte Spielvorbereitung</Link> · <Link to="/inhalte">Fragen und Pools bearbeiten</Link></p>
  </div>;
}
