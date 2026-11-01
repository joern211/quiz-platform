// ============================================================
// GameShell - Common game layout for all game types
// ============================================================

import { ReactNode } from 'react';
import { Timer } from '@quiz/ui';
import styles from './GameShell.module.css';

export interface GameShellProps {
  /** User role in the game */
  role: 'moderator' | 'player' | 'viewer';
  /** Room code for sharing */
  roomCode: string;
  /** Current game phase */
  phase?: string;
  /** Server-provided timer end timestamp */
  endsAt?: number;
  /** Connection status */
  connected?: boolean;
  /** Action or subscription error, announced to assistive technology */
  error?: string;
  /** Ready players count */
  readyCount?: number;
  /** Total players */
  totalPlayers?: number;
  /** Callback when user leaves */
  onLeave?: () => void;
  /** Game content - questions, answers, etc. */
  children: ReactNode;
}

/** Verständliche Phasenbezeichnung statt interner Kennung (Kennung bleibt als data-phase erhalten). */
const PHASE_LABELS: Record<string, string> = {
  WAITING: 'Warten',
  INPUT_OPEN: 'Antworten offen',
  REVEAL: 'Auflösung',
  PAUSED: 'Pausiert',
  ERROR_RECOVERY: 'Angehalten · Prüfung nötig',
  INTRO: 'Einleitung',
  SELECTING: 'Feldwahl',
  BUZZ_OPEN: 'Buzzer offen',
  BUZZ_LOCKED: 'Antwort läuft',
  STEAL_OPEN: 'Abstauben offen',
  STEAL_LOCKED: 'Abstauben läuft',
  FIELD_DONE: 'Feld beendet',
  BOARD_COMPLETE: 'Board fertig',
  ROUND_READY: 'Runde bereit',
  ANSWERING: 'Antwort läuft',
  GAME_END: 'Spielende',
};
export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

export function GameShell({
  role,
  roomCode,
  phase,
  endsAt,
  connected = true,
  error,
  readyCount,
  totalPlayers,
  onLeave,
  children,
}: GameShellProps) {
  return (
    <div className={styles.shell} data-phase={phase}>
      {/* ── Statusleiste ── */}
      <div className={styles.topBar}>
        <div className={styles.topLeft}>
          {phase && <span className={styles.phase} data-phase={phase}>{phaseLabel(phase)}</span>}
          <span className={styles.roomCode}>Code: {roomCode}</span>
          <span className={styles.status}>
            <span className={`${styles.statusDot} ${connected ? styles.connected : styles.disconnected}`} aria-hidden="true" />
            <span className={styles.statusText}>{connected ? 'Verbunden' : 'Getrennt'}</span>
          </span>
        </div>
        <div className={styles.topRight}>
          {endsAt && (
            <Timer endsAt={endsAt} />
          )}
        </div>
      </div>

      {/* ── Spielfläche (kein zweites <main>: App stellt bereits den Hauptbereich) ── */}
      <div className={styles.main}>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {children}
      </div>

      {/* ── Bottom Bar ── */}
      {(totalPlayers !== undefined || onLeave) && <div className={styles.bottomBar}>
        {totalPlayers !== undefined && (
          <div className={styles.playerCount}>
            {readyCount !== undefined && (
              <span className={styles.readyCount}>
                {readyCount} bereit
              </span>
            )}
            <span className={styles.totalCount}>
              {totalPlayers} Spiel{totalPlayers !== 1 ? 'er' : ''}
            </span>
          </div>
        )}
        {onLeave && (
          <button
            className={styles.leaveButton}
            onClick={onLeave}
            type="button"
          >
            {role === 'moderator' ? 'Raum schließen' : 'Verlassen'}
          </button>
        )}
      </div>}
    </div>
  );
}
