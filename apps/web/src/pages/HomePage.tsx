// ============================================================
// Home Page – v0.3.0 (CSS Modules, no inline styles)
// ============================================================

import { Link } from 'react-router-dom';
import { Card, Button } from '@quiz/ui';
import styles from './HomePage.module.css';

const featuredGames = [
  {
    slug: 'geo',
    name: 'Geografie-Quiz',
    icon: '🌍',
    shortRules: 'Hauptstädte, Flaggen, Flüsse und mehr — 4 Optionen, Joker verfügbar.',
    playerCount: { min: 2, max: 10 },
    duration: '15–30 Min',
    status: 'AVAILABLE',
  },
  {
    slug: 'jeopardy',
    name: 'Jeopardy',
    icon: '💰',
    shortRules: 'Wähle ein Feld, beantworte die Frage — oder schnappe sie dir als Abstauber!',
    playerCount: { min: 2, max: 10 },
    duration: '30–45 Min',
    status: 'AVAILABLE',
  },
  {
    slug: 'timeline',
    name: 'Timeline',
    icon: '📅',
    shortRules: 'Ordne Ereignisse in die richtige Reihenfolge. 3 Leben — wer hält durch?',
    playerCount: { min: 2, max: 10 },
    duration: '20–30 Min',
    status: 'AVAILABLE',
  },
  {
    slug: 'luegen',
    name: 'Wer lügt am besten?',
    icon: '🎭',
    shortRules: 'Schreibe eine falsche Antwort und täusche die anderen.',
    playerCount: { min: 3, max: 10 },
    duration: '20–30 Min',
    status: 'AVAILABLE',
  },
];

export function HomePage() {
  return (
    <div className={styles.page}>
      {/* ── Hero ── */}
      <section className={styles.hero}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowDot} />
          Multiplayer Quiz Plattform
        </div>

        <h1 className={styles.heroTitle}>
          Spiele mit Freunden
          <span className={styles.heroTitleAccent}>in Echtzeit</span>
        </h1>

        <p className={styles.heroSubtitle}>
          Erstelle einen Raum, lade deine Freunde ein und spielt gemeinsam —
          Geo-Quiz, Jeopardy, Timeline und mehr.
        </p>

        <div className={styles.heroCta}>
          <Link to="/kategorien">
            <Button size="lg">Spiele entdecken</Button>
          </Link>
          <div className={styles.heroOr}>oder</div>
          <Link to="/moderator/anmelden">
            <Button variant="secondary" size="lg">Raum erstellen</Button>
          </Link>
        </div>

        <div className={styles.heroStats}>
          <div className={styles.stat}>
            <div className={styles.statValue}>6</div>
            <div className={styles.statLabel}>Spielarten</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>2+</div>
            <div className={styles.statLabel}>Spieler</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>∞</div>
            <div className={styles.statLabel}>Spielspaß</div>
          </div>
        </div>
      </section>

      {/* ── How It Works ── */}
      <section className={`${styles.section} stagger`}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>So funktioniert's</h2>
        </div>
        <div className={styles.howItWorks}>
          {[
            { n: 1, title: 'Raum erstellen', desc: 'Wähle ein Spiel, konfiguriere es und bekomme einen Code.' },
            { n: 2, title: 'Freunde einladen', desc: 'Teile den Code — kein Account nötig.' },
            { n: 3, title: 'Spielen', desc: 'Buzzer, Fragen, Punkte — alles in Echtzeit.' },
            { n: 4, title: 'Gewinner feiern', desc: 'Live-Ergebnis und Rangliste nach jeder Runde.' },
          ].map(step => (
            <div key={step.n} className={styles.step}>
              <div className={styles.stepNumber}>{step.n}</div>
              <div className={styles.stepTitle}>{step.title}</div>
              <div className={styles.stepDesc}>{step.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Featured Games ── */}
      <section className={`${styles.section} stagger`}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Spiele</h2>
          <Link to="/kategorien" className={styles.sectionLink}>
            Alle ansehen →
          </Link>
        </div>
        <div className={styles.gameGrid}>
          {featuredGames.map(game => (
            <Link to={`/spiel/${game.slug}`} key={game.slug} className={styles.gameCard}>
              <Card interactive padding="none">
                <div className={styles.gameCardBody}>
                  <div className={styles.gameIcon}>{game.icon}</div>
                  <div className={styles.gameName}>{game.name}</div>
                  <div className={styles.gameDesc}>{game.shortRules}</div>
                </div>
                <div className={styles.gameCardFooter}>
                  <span>👥 {game.playerCount.min}–{game.playerCount.max}</span>
                  <span>⏱ {game.duration}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Quick join CTA ── */}
      <section className={styles.section}>
        <Card padding="lg" className={styles.quickCta}>
          <div className={styles.quickCtaTitle}>Du hast einen Raumcode?</div>
          <div className={styles.quickCtaSubtitle}>Dann tritt direkt ein — kein Login nötig.</div>
          <Link to="/beitreten">
            <Button size="lg">Raum beitreten →</Button>
          </Link>
        </Card>
      </section>

      {/* ── Zuschauer CTA ── */}
      <section className={styles.section}>
        <Card padding="lg" className={styles.viewerCta}>
          <div className={styles.viewerCtaTitle}>Kein Account nötig — einfach zuschauen</div>
          <div className={styles.viewerCtaSubtitle}>
            Hast du keinen Account, aber möchtest du ein laufendes Spiel verfolgen? Kein Problem.
          </div>
          <Link to="/zuschauen">
            <Button variant="secondary">Zuschauen →</Button>
          </Link>
        </Card>
      </section>
    </div>
  );
}
