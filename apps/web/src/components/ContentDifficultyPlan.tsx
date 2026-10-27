import { useEffect, useState } from 'react';
import { CONTENT_DIFFICULTIES, ContentDifficultyPlanSchema, contentDifficultySequence, type ContentDifficultyPlan, type ContentDifficultyPresetView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';

export const difficultyNames: Record<string, string> = { VERY_EASY: 'Sehr leicht', EASY: 'Leicht', MEDIUM: 'Mittel', HARD: 'Schwer', VERY_HARD: 'Sehr schwer' };
export function ContentDifficultyPlan({ gameSlug, count, plan, onChange }: { gameSlug: string; count: number; plan?: ContentDifficultyPlan; onChange: (plan?: ContentDifficultyPlan) => void }) {
  const [presets, setPresets] = useState<ContentDifficultyPresetView[]>([]), [name, setName] = useState(''), [choice, setChoice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; contentApi.difficultyPresets(gameSlug).then(rows => { if (active) { setPresets(rows); setError(''); } }, () => { if (active) setError('Schwierigkeitsvorlagen konnten nicht geladen werden.'); }); return () => { active = false; }; }, [gameSlug]);
  const matches = (p: ContentDifficultyPresetView) => JSON.stringify(p.plan) === JSON.stringify(plan);
  const selected = plan ? (presets.find(p => p.id === choice && matches(p)) ?? presets.find(matches))?.id ?? 'custom' : '';
  const parsed = ContentDifficultyPlanSchema.safeParse(plan);
  let sequence: string[] = [], invalid = '';
  if (plan) {
    if (!parsed.success) invalid = parsed.error.issues[0].message;
    else try { sequence = contentDifficultySequence(parsed.data, count); } catch { invalid = `Die Bereiche müssen genau die Fragen 1 bis ${count} abdecken.`; }
  }
  return <section className={styles.panel} aria-label="Schwierigkeitsverlauf"><h3>Schwierigkeitsverlauf</h3>
    <label>Schwierigkeitsvorlage<select aria-label="Schwierigkeitsvorlage" value={selected} onChange={e => { setChoice(e.target.value);
      if (!e.target.value) onChange(undefined);
      else if (e.target.value === 'distribution') onChange({ kind: 'DISTRIBUTION', percentages: { VERY_EASY: 20, EASY: 20, MEDIUM: 20, HARD: 20, VERY_HARD: 20 } });
      else if (e.target.value === 'ranges') onChange({ kind: 'RANGES', ranges: [{ from: 1, to: count, difficulty: 'MEDIUM' }] });
      else { const preset = presets.find(p => p.id === e.target.value); if (preset) onChange(structuredClone(preset.plan)); }
    }}><option value="">Kein Verlauf</option>{presets.map(p => <option key={p.id} value={p.id}>{p.name} · {p.scope === 'SYSTEM' ? 'System' : 'Eigene Vorlage'}</option>)}
      <option value="distribution">Eigene Prozentverteilung</option>{gameSlug === 'wissensduell' && <option value="ranges">Eigene Rundenbereiche</option>}{selected === 'custom' && <option value="custom" disabled>Eigener Verlauf</option>}
    </select></label>
    {plan?.kind === 'DISTRIBUTION' && <div className={styles.options}>{CONTENT_DIFFICULTIES.map(d => <label key={d}>{difficultyNames[d]} (%)<input type="number" min={0} max={100} value={plan.percentages[d]} onChange={e => onChange({ ...plan, percentages: { ...plan.percentages, [d]: Number(e.target.value) } })} /></label>)}</div>}
    {plan?.kind === 'RANGES' && <><p>Fragenfolge ab 1, lückenlos und ohne Überschneidungen.</p>{plan.ranges.map((r, i) => <fieldset key={i}><legend>Bereich {i + 1}</legend>
      <label>Von Frage<input type="number" min={1} max={100} value={r.from} onChange={e => onChange({ ...plan, ranges: plan.ranges.map((v, j) => j === i ? { ...v, from: Number(e.target.value) } : v) })} /></label>
      <label>Bis Frage<input type="number" min={1} max={100} value={r.to} onChange={e => onChange({ ...plan, ranges: plan.ranges.map((v, j) => j === i ? { ...v, to: Number(e.target.value) } : v) })} /></label>
      <label>Schwierigkeit<select value={r.difficulty} onChange={e => onChange({ ...plan, ranges: plan.ranges.map((v, j) => j === i ? { ...v, difficulty: e.target.value as typeof r.difficulty } : v) })}>{CONTENT_DIFFICULTIES.map(d => <option key={d} value={d}>{difficultyNames[d]}</option>)}</select></label>
      <button disabled={plan.ranges.length === 1} onClick={() => onChange({ ...plan, ranges: plan.ranges.filter((_, j) => j !== i) })}>Bereich entfernen</button>
    </fieldset>)}<button disabled={plan.ranges.length >= 100 || plan.ranges.at(-1)!.to >= count} onClick={() => onChange({ ...plan, ranges: [...plan.ranges, { from: plan.ranges.at(-1)!.to + 1, to: count, difficulty: 'HARD' }] })}>Bereich hinzufügen</button></>}
    {plan?.kind === 'RISING' && <p>Die Fragen werden über Leicht → Mittel → Schwer angeordnet. Die Bereiche passen sich an die Fragenzahl an.</p>}
    {invalid && <p role="alert">{invalid}</p>}
    {!!sequence.length && <p role="status">{count} Fragen: {CONTENT_DIFFICULTIES.map(d => ({ d, n: sequence.filter(v => v === d).length })).filter(v => v.n).map(v => `${v.n} ${difficultyNames[v.d]}`).join(' · ')}</p>}
    {plan?.kind === 'DISTRIBUTION' && <p>Die Anzahlen werden auf ganze Fragen gerundet; die Reihenfolge ist zufällig. Ohne Schwierigkeitsangabe passt eine Frage in keinen Verlauf.</p>}
    {gameSlug === 'jeopardy' && <p>Jeopardy verteilt Fragen auf das Board. Rundenbereiche sind hier nicht verfügbar.</p>}
    {error && <p role="alert">{error}</p>}
    {plan && <><label>Name der eigenen Schwierigkeitsvorlage<input maxLength={150} value={name} onChange={e => setName(e.target.value)} /></label>
      <button disabled={busy || !!invalid || !name.trim()} onClick={async () => { setBusy(true); setError(''); try {
        const saved = await contentApi.saveDifficultyPreset(gameSlug, name, plan); setPresets(rows => [...rows, saved.preset]); setChoice(saved.preset.id); setName('');
      } catch (e) { setError(e instanceof Error ? e.message : 'Vorlage konnte nicht gespeichert werden.'); } finally { setBusy(false); } }}>Schwierigkeitsvorlage speichern</button></>}
    {presets.find(p => p.id === selected)?.scope === 'PRIVATE' && <button disabled={busy} onClick={async () => {
      const preset = presets.find(p => p.id === selected)!;
      if (!window.confirm('Diese eigene Schwierigkeitsvorlage archivieren? Die aktuelle Auswahl und bestehende Partien bleiben erhalten.')) return;
      setBusy(true); try { await contentApi.archiveDifficultyPreset(preset); setPresets(rows => rows.filter(p => p.id !== preset.id)); } catch (e) { setError(e instanceof Error ? e.message : 'Archivierung fehlgeschlagen.'); } finally { setBusy(false); }
    }}>Eigene Schwierigkeitsvorlage archivieren</button>}
  </section>;
}
