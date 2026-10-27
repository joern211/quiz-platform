import { useEffect, useRef, useState } from 'react';
import { ContentMediaRightsSchema, type ContentItemView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import { ContentMedia } from './ContentMedia';

export function ContentMediaFields({ item, payload, disabled, onChange }: { item: ContentItemView | null; payload: Record<string, unknown>; disabled: boolean; onChange: (values: Record<string, unknown>) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<{ url: string; type: string } | null>(null);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => setPreview(null), [item?.id, item?.revision]);
  const parsedRights = ContentMediaRightsSchema.safeParse(payload.mediaRights);
  const rights = parsedRights.success ? parsedRights.data : ContentMediaRightsSchema.parse({});
  const changeRight = (key: string, value: unknown) => onChange({ mediaRights: { ...rights, [key]: value } });
  const load = async () => { if (!item) return; try { setPreview(await contentApi.media(item.id)); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Medium konnte nicht geladen werden.'); } };
  return <fieldset><legend>Bild oder Audio</legend>
    {error && <p role="alert">{error}</p>}
    <label>Medium hochladen<input type="file" accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/wav" disabled={disabled || busy} onChange={async e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setBusy(true); setError('');
      try {
        const body = new FormData(); body.append('file', file);
        const response = await fetch('/api/v1/media', { method: 'POST', credentials: 'include', body }), json = await response.json();
        if (!response.ok || !json.success) throw new Error(json.error?.message ?? 'Upload fehlgeschlagen.');
        if (alive.current) { onChange({ mediaAssetId: json.data.id, mediaType: json.data.type, mediaRights: ContentMediaRightsSchema.parse({}) }); setPreview(null); }
      } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Upload fehlgeschlagen.'); }
      finally { if (alive.current) setBusy(false); }
    }} /></label>
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
