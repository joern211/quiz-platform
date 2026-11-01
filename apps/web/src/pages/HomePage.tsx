// ============================================================
// Startseite – Midnight: Bühne, Show-Titel, Programmkarten
// Nur echte Katalogdaten; keine erfundenen Kennzahlen.
// ============================================================

import { Link } from 'react-router-dom';
import { ButtonLink, Badge } from '@quiz/ui';
import { startableGames } from '../lib/catalog';
import { GameArt } from '../components/GameArt';
import styles from './HomePage.module.css';

const games = startableGames();

export function HomePage() {
  return (
    <div className={styles.page}>
      <section className={styles.stage} aria-labelledby="home-title">
        <span className={styles.showBadge}><span className={styles.dot} aria-hidden="true" />Dein Wohnzimmer. Deine Quizshow.</span>
        <h1 id="home-title" className={styles.title}>
          Heute spielt <em>ihr die Hauptrolle.</em>
        </h1>
        <p className={styles.lead}>
          {games.length} Spiele. Eine gemeinsame Runde. Raum erstellen, Code teilen –
          Mitspielende brauchen kein Konto.
        </p>
        <div className={styles.cta}>
          <ButtonLink to="/moderator/anmelden" size="lg">
            Raum erstellen <span aria-hidden="true">→</span>
          </ButtonLink>
          <ButtonLink to="/beitreten" variant="secondary" size="lg">Mit Raumcode beitreten</ButtonLink>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="programm-title">
        <div className={styles.sectionHead}>
          <h2 id="programm-title">Das Programm für euren Abend</h2>
          <Link to="/kategorien" className={styles.sectionLink}>Alle Spiele <span aria-hidden="true">→</span></Link>
        </div>
        <ul className={styles.programme}>
          {games.map((game) => (
            <li key={game.slug}>
              <Link to={`/spiel/${game.slug}`} className={styles.programmeCard}>
                <GameArt slug={game.slug} className={styles.art} />
                <span className={styles.copy}>
                  <span className={styles.cardTitle}>
                    {game.name}
                    {game.status === 'BETA' && <Badge variant="warning">Beta</Badge>}
                  </span>
                  <span className={styles.cardText}>{game.shortRules}</span>
                  <span className={styles.cardMeta}>
                    <span>{game.category}</span>
                    <span>{game.playerCount.min}–{game.playerCount.max} Spieler</span>
                    <span>{game.duration}</span>
                  </span>
                </span>
                <span className={styles.arrow} aria-hidden="true">↗</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <ul className={styles.showFooter} aria-label="Gut zu wissen">
        <li>Im Browser spielen</li>
        <li>Mitspielende ohne Konto</li>
        <li><Link to="/zuschauen" className={styles.watchLink}>Als Zuschauer dabei sein <span aria-hidden="true">↗</span></Link></li>
      </ul>
    </div>
  );
}
