import { useEffect, useState } from 'react';
import type { GamePresetConfiguration, SetupBlueprintInput, SetupBlueprintView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import { blueprintConfiguration, type BlueprintApplication } from '../lib/setupBlueprints';
import styles from '../pages/ContentPage.module.css';

export function SetupBlueprints({ gameSlug, current, onApply }: { gameSlug: string; current: () => GamePresetConfiguration; onApply: (configuration: GamePresetConfiguration, application: BlueprintApplication) => void }) {
  const [rows, setRows] = useState<SetupBlueprintView[]>([]), [game, setGame] = useState<SetupBlueprintView | null>(null), [template, setTemplate] = useState<SetupBlueprintView | null>(null);
  const [gameId, setGameId] = useState(''), [roomId, setRoomId] = useState(''), [gameName, setGameName] = useState(''), [roomName, setRoomName] = useState('');
  const [language, setLanguage] = useState('de-DE'), [preferred, setPreferred] = useState<string[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; contentApi.setupBlueprints(gameSlug).then(data => { if (active) setRows(data); }, () => { if (active) setError('Vorlagen konnten nicht geladen werden.'); }); return () => { active = false; }; }, [gameSlug]);
  const run = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Vorlagenaktion fehlgeschlagen.'); } finally { setBusy(false); } };
  const replace = (value: SetupBlueprintView) => setRows(prior => [...prior.filter(r => r.id !== value.id), value]);
  const apply = (nextGame: SetupBlueprintView | null, nextRoom: SetupBlueprintView | null) => { const result = blueprintConfiguration(current(), nextGame, nextRoom); setGame(nextGame); setTemplate(nextRoom); onApply(result.configuration, result.application); setNotice('Vorlage übernommen. Du kannst die Werte vor der Raumerstellung anpassen.'); };
  const load = (row: SetupBlueprintView) => run(async () => {
    const loaded = (await contentApi.loadSetupBlueprint(row)).blueprint;
    if (!window.confirm('Die vorbereiteten Einstellungen durch diese Vorlage ersetzen? Raumname und PIN bleiben erhalten.')) return;
    if (loaded.kind === 'GAME_PRESET') { setGameName(loaded.name); apply(loaded, template); }
    else { setRoomName(loaded.name); setLanguage(loaded.configuration.language ?? 'de-DE'); setPreferred(loaded.configuration.preferredGamePresetIds); apply(game, loaded); }
  });
  const inputFor = (kind: 'GAME_PRESET' | 'ROOM_TEMPLATE'): SetupBlueprintInput => kind === 'GAME_PRESET'
    ? { kind, gameSlug: gameSlug as 'wissensduell' | 'jeopardy', name: gameName, favorite: false, configuration: current() }
    : { kind, gameSlug: null, name: roomName, favorite: false, configuration: { room: current().room, language: language as 'de-DE' | 'en-US' | 'tr-TR', preferredGamePresetIds: preferred } };
  const save = (kind: 'GAME_PRESET' | 'ROOM_TEMPLATE', update = false) => run(async () => {
    const selected = rows.find(r => r.id === (kind === 'GAME_PRESET' ? gameId : roomId));
    if (update && (!selected || !window.confirm('Diese Vorlage als neue Version speichern? Bereits erstellte Räume bleiben erhalten.'))) return;
    const input = inputFor(kind); if (update && selected) input.favorite = selected.favorite;
    const row = (await contentApi.saveSetupBlueprint(input, update ? selected : undefined)).blueprint; replace(row);
    if (row.kind === 'GAME_PRESET') { setGameId(row.id); setGameName(row.name); } else { setRoomId(row.id); setRoomName(row.name); }
    setNotice('Vorlage gespeichert. Zum Anwenden auf den Raum ausdrücklich übernehmen.');
  });
  const controls = (row: SetupBlueprintView | undefined) => row && <div className={styles.actions}>
    <button disabled={busy} onClick={() => void load(row)}>Übernehmen</button>
    {row.scope === 'PRIVATE' && <><button disabled={busy} onClick={() => void run(async () => {
      const input: SetupBlueprintInput = row.kind === 'GAME_PRESET' ? { kind: row.kind, gameSlug: row.gameSlug, name: row.name, favorite: !row.favorite, configuration: row.configuration } : { kind: row.kind, gameSlug: null, name: row.name, favorite: !row.favorite, configuration: row.configuration };
      const updated = (await contentApi.saveSetupBlueprint(input, row)).blueprint; replace(updated);
      if (game?.id === row.id || template?.id === row.id) { const nextGame = game?.id === row.id ? updated : game, nextTemplate = template?.id === row.id ? updated : template; const result = blueprintConfiguration(current(), nextGame, nextTemplate); setGame(nextGame); setTemplate(nextTemplate); onApply(current(), result.application); } setNotice(row.favorite ? 'Favorit entfernt.' : 'Als Favorit gespeichert.');
    })}>{row.favorite ? 'Favorit entfernen' : 'Als Favorit pinnen'}</button>
    <button disabled={busy} onClick={() => void run(async () => { if (!window.confirm('Vorlage archivieren? Bestehende Räume bleiben erhalten.')) return; await contentApi.archiveSetupBlueprint(row); setRows(prior => prior.filter(r => r.id !== row.id)); setNotice('Vorlage archiviert. Bereits übernommene Verweise müssen vor der Raumerstellung neu gewählt werden.'); })}>Vorlage archivieren</button></>}
  </div>;
  const games = rows.filter(r => r.kind === 'GAME_PRESET').sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  return <section className={styles.panel} aria-label="Spiel- und Raumvorlagen"><h2>Spiel- und Raumvorlagen</h2>
    <p>Vorbereiten, als Vorlage speichern und später wiederverwenden. PIN und Anmeldedaten werden nicht gespeichert. Ein Spiel-Preset hat Vorrang vor der Raumvorlage; deine späteren Änderungen haben Vorrang vor beiden.</p>
    {(game || template) && <p>Übernommen: {template?.name ?? 'keine Raumvorlage'} · {game?.name ?? 'kein Spiel-Preset'}. <button onClick={() => { setGame(null); setTemplate(null); onApply(current(), { baseline: { room: {}, setup: {} } }); setNotice('Vorlagenverweise entfernt. Deine aktuellen Einstellungen bleiben erhalten.'); }}>Mit aktuellen Einstellungen ohne Vorlagen fortfahren</button></p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset><legend>Spiel-Presets</legend><label>Spiel-Preset<select aria-label="Spiel-Preset" value={gameId} onChange={e => { setGameId(e.target.value); setGameName(rows.find(r => r.id === e.target.value)?.name ?? ''); }}><option value="">Preset auswählen</option>{games.map(r => <option key={r.id} value={r.id}>{r.favorite ? '★ ' : ''}{r.name} · V{r.revision}{preferred.includes(r.id) ? ' · empfohlen' : ''}</option>)}</select></label>
      {controls(rows.find(r => r.id === gameId))}
      <label>Presetname<input maxLength={150} value={gameName} onChange={e => setGameName(e.target.value)} /></label><div className={styles.actions}>
        <button disabled={busy || !gameName.trim()} onClick={() => void save('GAME_PRESET')}>Aktuelle Konfiguration als Preset speichern</button>
        <button disabled={busy || !gameName.trim() || !games.some(r => r.id === gameId && r.scope === 'PRIVATE')} onClick={() => void save('GAME_PRESET', true)}>Ausgewähltes Preset aktualisieren</button>
      </div>
    </fieldset>
    <fieldset><legend>Room Templates</legend><label>Raumvorlage<select aria-label="Raumvorlage" value={roomId} onChange={e => { setRoomId(e.target.value); const row = rows.find(r => r.id === e.target.value); setRoomName(row?.name ?? ''); if (row?.kind === 'ROOM_TEMPLATE') { setLanguage(row.configuration.language ?? 'de-DE'); setPreferred(row.configuration.preferredGamePresetIds); } }}><option value="">Raumvorlage auswählen</option>{rows.filter(r => r.kind === 'ROOM_TEMPLATE').map(r => <option key={r.id} value={r.id}>{r.favorite ? '★ ' : ''}{r.name} · {r.scope === 'SYSTEM' ? 'System' : `V${r.revision}`}</option>)}</select></label>
      {controls(rows.find(r => r.id === roomId))}
      <label>Name der Raumvorlage<input maxLength={150} value={roomName} onChange={e => setRoomName(e.target.value)} /></label>
      <label>Vorlagensprache<select aria-label="Vorlagensprache" value={language} onChange={e => setLanguage(e.target.value)}>{['de-DE', 'en-US', 'tr-TR'].map(l => <option key={l}>{l}</option>)}</select></label>
      <label>Bevorzugte Spiel-Presets<select aria-label="Bevorzugte Spiel-Presets" multiple value={preferred} onChange={e => setPreferred(Array.from(e.target.selectedOptions, o => o.value))}>{games.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <div className={styles.actions}><button disabled={busy || !roomName.trim()} onClick={() => void save('ROOM_TEMPLATE')}>Raumeinstellungen als Vorlage speichern</button>
        <button disabled={busy || !roomName.trim() || !rows.some(r => r.id === roomId && r.scope === 'PRIVATE')} onClick={() => void save('ROOM_TEMPLATE', true)}>Ausgewählte Raumvorlage aktualisieren</button></div>
    </fieldset>
  </section>;
}
