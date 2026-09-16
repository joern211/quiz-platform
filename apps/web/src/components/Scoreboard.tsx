// ============================================================
// Scoreboard Component
// ============================================================

import styles from './Scoreboard.module.css';

interface Player {
  id: string;
  displayName: string;
  score: number;
  ready?: boolean;
  connected?: boolean;
  lives?: number; // For games with lives
  jokers?: {
    used5050: boolean;
    usedSpy: boolean;
    usedRisk: boolean;
  };
  avatarMode?: 'none' | 'avatar' | 'camera';
  avatarGenerated?: {
    initials: string;
    color: string;
  };
}

interface ScoreboardProps {
  players: Player[];
  currentPlayerId?: string;
  showJokers?: boolean;
  compact?: boolean;
}

export function Scoreboard({ 
  players, 
  currentPlayerId,
  showJokers = false,
  compact = false 
}: ScoreboardProps) {
  // Sort by score descending
  const sortedPlayers = [...players].sort((a, b) => b.score - a.score);

  return (
    <div className={`${styles.scoreboard} ${compact ? styles.compact : ''}`}>
      {sortedPlayers.map((player, index) => (
        <div 
          key={player.id}
          className={`${styles.player} ${player.id === currentPlayerId ? styles.current : ''} ${!player.connected ? styles.disconnected : ''}`}
        >
          <span className={styles.rank}>#{index + 1}</span>
          
          <div className={styles.avatar}>
            {player.avatarMode === 'none' && (
              <div className={styles.avatarPlaceholder}>
                {player.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            {player.avatarMode === 'avatar' && player.avatarGenerated && (
              <div 
                className={styles.avatarGenerated}
                style={{ backgroundColor: player.avatarGenerated.color }}
              >
                {player.avatarGenerated.initials}
              </div>
            )}
          </div>
          
          <div className={styles.info}>
            <span className={styles.name}>
              {player.displayName}
              {player.id === currentPlayerId && <span className={styles.youBadge}>Du</span>}
            </span>
            {showJokers && player.jokers && (
              <div className={styles.jokers}>
                <span className={player.jokers.used5050 ? styles.used : ''}>50:50</span>
                <span className={player.jokers.usedSpy ? styles.used : ''}>Spy</span>
                <span className={player.jokers.usedRisk ? styles.used : ''}>Risk</span>
              </div>
            )}
          </div>
          
          <div className={styles.stats}>
            <span className={styles.score}>{player.score}</span>
            {player.lives !== undefined && (
              <span className={styles.lives}>
                {'❤️'.repeat(player.lives)}
                {player.lives === 0 && <span className={styles.ko}>KO</span>}
              </span>
            )}
          </div>
          
          {player.ready && (
            <span className={styles.readyBadge} title="Bereit">✓</span>
          )}
          {!player.connected && (
            <span className={styles.disconnectedBadge} title="Getrennt">⚡</span>
          )}
        </div>
      ))}
    </div>
  );
}
