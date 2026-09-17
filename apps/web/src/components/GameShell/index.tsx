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
  /** Ready players count */
  readyCount?: number;
  /** Total players */
  totalPlayers?: number;
  /** Callback when user leaves */
  onLeave?: () => void;
  /** Game content - questions, answers, etc. */
  children: ReactNode;
}

export function GameShell({
  role,
  roomCode,
  phase,
  endsAt,
  connected = true,
  readyCount,
  totalPlayers,
  onLeave,
  children,
}: GameShellProps) {
  return (
    <div className={styles.shell}>
      {/* ── Top Bar ── */}
      <header className={styles.topBar}>
        <div className={styles.topLeft}>
          {phase && <span className={styles.phase}>{phase}</span>}
          <span className={styles.roomCode}>Code: {roomCode}</span>
        </div>
        <div className={styles.topRight}>
          {endsAt && (
            <Timer endsAt={endsAt} />
          )}
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className={styles.main}>
        {children}
      </main>

      {/* ── Bottom Bar ── */}
      <footer className={styles.bottomBar}>
        <div className={styles.status}>
          <span className={`${styles.statusDot} ${connected ? styles.connected : styles.disconnected}`} />
          <span className={styles.statusText}>
            {connected ? 'Verbunden' : 'Getrennt'}
          </span>
        </div>
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
      </footer>
    </div>
  );
}
