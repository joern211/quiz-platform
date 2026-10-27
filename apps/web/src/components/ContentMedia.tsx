import { useEffect, useState } from 'react';
import styles from './ContentMedia.module.css';

export function ContentMedia({ mediaUrl, mediaType, onRefresh }: { mediaUrl?: string; mediaType?: string; onRefresh?: () => void }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); }, [mediaUrl]);
  if (!mediaUrl) return null;
  return <div className={styles.media}>
    {failed ? <p role="status">Das Medium kann gerade nicht geladen werden. <button onClick={() => { setFailed(false); setAttempt(v => v + 1); onRefresh?.(); }}>Medium erneut laden</button></p>
      : mediaType === 'audio' ? <audio key={`${mediaUrl}:${attempt}`} controls preload="metadata" src={mediaUrl} onError={() => setFailed(true)} aria-label="Audio zur Frage" />
        : <img key={`${mediaUrl}:${attempt}`} src={mediaUrl} alt="Bild zur Frage" onError={() => setFailed(true)} />}
  </div>;
}
