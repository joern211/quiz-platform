import { uploadMediaJob, waitMediaJob, retryMediaJob, type MediaJobView } from '../lib/mediaJobs';
import { useEffect, useRef, useState } from 'react';
import { ContentMediaRightsSchema, type ContentItemView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import { ContentMedia } from './ContentMedia';

export function ContentMediaFields({ item, payload, disabled, onChange }: { item: ContentItemView | null; payload: Record<string, unknown>; disabled: boolean; onChange: (values: Record<string, unknown>) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<{ url: string; type: string } | null>(null);
  const [job, setJob] = useState<MediaJobView | null>(null);
  const generation = useRef({ value: 0 }), abort = useRef<AbortController | null>(null), changeRef = useRef(onChange); changeRef.current = onChange;
  const storageKey = item?.id ? `qp:media-job:${item.id}` : null;
  const persistJob = (id: string | null) => { if (!storageKey) return; try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch { /* Upload still works without session storage. */ } };
  const monitor = async (id: string, expected: number, controller: AbortController) => {
    const result = await waitMediaJob(id, controller.signal, next => { if (generation.current.value === expected) setJob(next); });
    if (generation.current.value !== expected || controller.signal.aborted) return;
    if (result.status === 'READY' && result.asset) { changeRef.current({ mediaAssetId: result.asset.id, mediaType: result.asset.type, mediaRights: ContentMediaRightsSchema.parse({}) }); setPreview(null); persistJob(null); setJob(null); }
    else setError(result.status === 'REJECTED' ? 'Die Datei wurde bei der Inhaltsprüfung abgewiesen.' : 'Die Verarbeitung ist fehlgeschlagen. Du kannst sie erneut versuchen.');
  };
  const monitorRef = useRef(monitor); monitorRef.current = monitor;
  useEffect(() => {
    const stamp = generation.current, expected = ++stamp.value; abort.current?.abort(); const controller = new AbortController(); abort.current = controller; setBusy(false); setJob(null); setError('');
    let id: string | null = null; try { if (storageKey) id = sessionStorage.getItem(storageKey); } catch { /* no persisted job */ }
    if (id) { setBusy(true); void monitorRef.current(id, expected, controller).catch(e => { if (generation.current.value === expected && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Verarbeitung nicht erreichbar.'); }).finally(() => { if (generation.current.value === expected) setBusy(false); }); }
    return () => { stamp.value++; controller.abort(); };
  }, [storageKey]);
  useEffect(() => setPreview(null), [item?.id, item?.revision]);
  const parsedRights = ContentMediaRightsSchema.safeParse(payload.mediaRights);
  const rights = parsedRights.success ? parsedRights.data : ContentMediaRightsSchema.parse({});
  const changeRight = (key: string, value: unknown) => onChange({ mediaRights: { ...rights, [key]: value } });
  const load = async () => { if (!item) return; try { setPreview(await contentApi.media(item.id)); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Medium konnte nicht geladen werden.'); } };
  return <fieldset><legend>Bild oder Audio</legend>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Medium wird geprüft und verarbeitet …</p>}
    <label>Medium hochladen<input type="file" accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/wav,audio/aac,audio/ogg,.m4a,.aac" disabled={disabled || busy} onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setBusy(true); setError('');
      const expected = generation.current.value; abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
      const commandId = crypto.randomUUID();
      try {
        const queued = await uploadMediaJob(file, commandId, controller.signal);
        if (generation.current.value !== expected || controller.signal.aborted) return;
        persistJob(queued.id); setJob(queued); await monitor(queued.id, expected, controller);
      } catch (e) { if (generation.current.value === expected && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Upload fehlgeschlagen.'); }
      finally { if (generation.current.value === expected) setBusy(false); }
    }} /></label>
    {job && !busy && <button disabled={disabled} onClick={async () => {
      const expected = generation.current.value; const controller = new AbortController(); abort.current?.abort(); abort.current = controller; setBusy(true); setError('');
      try { if (job.status === 'FAILED' && job.retryable) await retryMediaJob(job.id, controller.signal); await monitor(job.id, expected, controller); }
      catch (e) { if (generation.current.value === expected && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Verarbeitung nicht erreichbar.'); }
      finally { if (generation.current.value === expected) setBusy(false); }
    }}>{job.status === 'FAILED' && job.retryable ? 'Verarbeitung erneut versuchen' : 'Verarbeitung erneut prüfen'}</button>}
    {Boolean(payload.mediaAssetId || payload.mediaType || payload.mediaRights) && <><p>{payload.mediaAssetId ? `${payload.mediaType === 'audio' ? 'Audio' : 'Bild'} verknüpft. Ein Austausch verändert keine gespeicherte Partie.` : 'Medienoptionen vorbereitet. Lade eine Datei hoch oder entferne die Medienoptionen.'}</p>
      <button disabled={disabled || busy} onClick={() => { onChange({ mediaAssetId: undefined, mediaType: undefined, mediaRights: undefined }); setPreview(null); }}>Medium aus Frage entfernen</button>
      <label>Medienquelle<input disabled={disabled} value={rights.source} onChange={e => changeRight('source', e.target.value)} /></label>
      <label>Quellen-URL des Mediums<input type="url" disabled={disabled} value={rights.sourceUrl} onChange={e => changeRight('sourceUrl', e.target.value)} /></label>
      <label>Autor / Rechteinhaber<input disabled={disabled} value={rights.author} onChange={e => changeRight('author', e.target.value)} /></label>
      <label>Medienlizenz / Nutzungserlaubnis<input disabled={disabled} value={rights.license} onChange={e => changeRight('license', e.target.value)} /></label>
      <label><input type="checkbox" disabled={disabled} checked={rights.ownMaterial} onChange={e => changeRight('ownMaterial', e.target.checked)} />Eigenes Material</label>
      <label><input type="checkbox" disabled={disabled} checked={rights.recognizablePerson} onChange={e => changeRight('recognizablePerson', e.target.checked)} />Erkennbare Privatperson</label>
      {rights.recognizablePerson && <label><input type="checkbox" disabled={disabled} checked={rights.consent} onChange={e => changeRight('consent', e.target.checked)} />Einwilligung zur vorgesehenen Nutzung liegt vor</label>}
      {item && typeof payload.mediaAssetId === 'string' && <button disabled={busy} onClick={() => void load()}>Gespeichertes Medium anzeigen</button>}
      {preview && <ContentMedia mediaUrl={preview.url} mediaType={preview.type} onRefresh={() => void load()} />}
    </>}
  </fieldset>;
}
