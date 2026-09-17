// ============================================================
// Game Card Component – v0.3.0 (Semantic, keyboard accessible, no nested links)
// ============================================================

import { Link } from 'react-router-dom';
import { Card, Badge, InfoPopup } from '@quiz/ui';
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
  status: 'AVAILABLE' | 'BETA' | 'PLANNED';
}

interface GameCardProps {
  game: Game;
}

const statusBadge = {
  AVAILABLE: { label: 'Verfügbar', variant: 'success' as const },
  BETA: { label: 'Beta', variant: 'warning' as const },
  PLANNED: { label: 'Geplant', variant: 'muted' as const },
};

export function GameCard({ game }: GameCardProps) {
  const badge = statusBadge[game.status];

  const tags = [];
  if (game.hasBuzzer)  tags.push('Buzzer');
  if (game.hasTeams)   tags.push('Teams');
  if (game.hasCamera)  tags.push('Kamera');
  if (game.hasAudio)   tags.push('Audio');

  const rules = [
    `Spieleranzahl: ${game.playerCount.min}-${game.playerCount.max}`,
    `Dauer: ${game.duration}`,
    ...(game.hasBuzzer ? ['Buzzer-Spiel'] : []),
    ...(game.hasTeams ? ['Team-Modus verfügbar'] : []),
  ];

  return (
    <article className={styles.card} aria-label={`Spiel: ${game.name}`}>
      <div className={styles.header}>
        <h3 className={styles.name}>{game.name}</h3>
        <div className={styles.badges}>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {tags.map(tag => (
            <Badge key={tag} variant="muted">{tag}</Badge>
          ))}
        </div>
      </div>

      <p className={styles.category}>{game.category}</p>

      <div className={styles.meta}>
        <span>👥 {game.playerCount.min}–{game.playerCount.max} Spieler</span>
        <span>⏱ {game.duration}</span>
      </div>

      <div className={styles.actions}>
        <InfoPopup
          title={game.name}
          content={game.shortRules}
          rules={rules}
        />

        <Link
          to={`/spiel/${game.slug}`}
          className={styles.playLink}
          aria-label={`${game.name} spielen`}
        >
          Spielen →
        </Link>
      </div>
    </article>
  );
}
