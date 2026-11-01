// ============================================================
// GameArt – ruhige Symbolfläche je Spiel (Midnight-Programmkarte)
// Spielfarben sind feste, neutrale Kennfarben je Spiel und hängen
// bewusst nicht vom persönlichen Akzent ab.
// ============================================================

import styles from './GameArt.module.css';

function Icon({ slug }: { slug: string }) {
  if (slug === 'wissensduell') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5c4 2 10 2 14 0M5 17.5c4-2 10-2 14 0" />
      </svg>
    );
  }
  if (slug === 'jeopardy') {
    return (
      <span className={styles.board} aria-hidden="true">
        {[100, 200, 300, 400, 500, 600].map((v) => <span key={v}>{v}</span>)}
      </span>
    );
  }
  if (slug === 'wer-ist-das') {
    return (
      <span className={styles.face} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="12" cy="8" r="4" /><path d="M4 22v-2a8 8 0 0 1 16 0v2" /></svg>
        <span>?</span>
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function GameArt({ slug, className = '' }: { slug: string; className?: string }) {
  return (
    <span className={`${styles.art} ${className}`} data-game={slug} aria-hidden="true">
      <Icon slug={slug} />
    </span>
  );
}
