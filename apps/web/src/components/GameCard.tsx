// ============================================================
// Game Card Component
// ============================================================

import { Link } from 'react-router-dom';
import { Badge, InfoPopup } from '@quiz/ui';
import { GameArt } from './GameArt';
import styles from './GameCard.module.css';

interface Game {
  slug: string;
  name: string;
  category: string;
  shortRules: string;
  playerCount: { min: number; max: number };
  duration: string;
  hasBuzzer: boolean;
  hasTeams: boolean;
  hasCamera: boolean;
  hasAudio: boolean;
  status: 'AVAILABLE' | 'BETA' | 'PLANNED' | 'HIDDEN';
}

interface GameCardProps {
  game: Game;
}

export function GameCard({ game }: GameCardProps) {
  const statusBadge = {
    AVAILABLE: { label: 'Verfügbar', variant: 'success' as const },
    BETA: { label: 'Beta', variant: 'warning' as const },
    PLANNED: { label: 'Geplant', variant: 'muted' as const },
    HIDDEN: { label: 'Intern', variant: 'muted' as const },
  }[game.status];

  const tags = [];
  if (game.hasBuzzer) tags.push('Buzzer');
  if (game.hasTeams) tags.push('Teams');
  if (game.hasCamera) tags.push('Kamera');
  if (game.hasAudio) tags.push('Audio');

  return (
    <article className={styles.card} data-status={game.status}>
      <GameArt slug={game.slug} className={styles.art} />
      <div className={styles.body}>
        <div className={styles.header}>
          <h3 className={styles.name}>{game.name}</h3>
          <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
        </div>
        <p className={styles.rules}>{game.shortRules}</p>
        <p className={styles.meta}>
          <span>{game.category}</span>
          <span>{game.playerCount.min}–{game.playerCount.max} Spieler</span>
          <span>{game.duration}</span>
          {tags.map(tag => <span key={tag}>{tag}</span>)}
        </p>
        <div className={styles.actions}>
          <InfoPopup
            title={game.name}
            content={game.shortRules}
            rules={[
              `Spieleranzahl: ${game.playerCount.min}-${game.playerCount.max}`,
              `Dauer: ${game.duration}`,
              ...(game.hasBuzzer ? ['Buzzer-Spiel'] : []),
              ...(game.hasTeams ? ['Team-Modus verfügbar'] : []),
            ]}
          />
          <Link to={`/spiel/${game.slug}`} className={styles.playLink}>
            {game.status === 'PLANNED' ? 'Details' : 'Spielen'} <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </article>
  );
}
