// ============================================================
// Home Page – v0.2.0 (Gamified + playful)
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
          Multiplayer Quiz Platform
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
            <div className={styles.statLabel}>Spiele</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>11</div>
            <div className={styles.statLabel}>Kategorien</div>
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
            { n: 2, title: 'Freunde einladen', desc: 'Teile den 6-stelligen Code —无需 Account.' },
            { n: 3, title: 'Spielen', desc: 'Buzzer, Fragen, Punkte — alles in Echtzeit.' },
            { n: 4, title: 'Gewinner feiern', desc: 'Live-Ergebnis und Leaderboard nach jeder Runde.' },
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
            <Link to={`/spiel/${game.slug}`} key={game.slug}>
              <Card interactive padding="none" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: 'var(--space-4)' }}>
                  <div style={{ fontSize: '2.5rem', marginBottom: 'var(--space-2)' }}>{game.icon}</div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, marginBottom: 'var(--space-1)', fontSize: '1.1rem' }}>
                    {game.name}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                    {game.shortRules}
                  </div>
                </div>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: 'var(--space-3) var(--space-4)',
                  borderTop: '1px solid var(--border)',
                  fontSize: '0.75rem',
                  color: 'var(--muted)',
                  marginTop: 'auto',
                }}>
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
        <Card padding="lg" className="glass" style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontWeight: 700, marginBottom: 'var(--space-3)' }}>
            Du hast einen Raumcode?
          </div>
          <div style={{ color: 'var(--muted)', marginBottom: 'var(--space-5)', fontSize: '0.9rem' }}>
            Dann tritt direkt ein — kein Login nötig.
          </div>
          <Link to="/beitreten">
            <Button size="lg">Raum beitreten →</Button>
          </Link>
        </Card>
      </section>
    </div>
  );
}
