// ============================================================
// Home Page
// ============================================================

import { Link } from 'react-router-dom';
import { Card, Button } from '@quiz/ui';
import styles from './HomePage.module.css';

export function HomePage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.title}>
          Spiele mit Freunden
        </h1>
        <p className={styles.subtitle}>
          Quiz, Buzzer, Schätzen und mehr — für 2 bis 10 Spieler
        </p>
        <div className={styles.actions}>
          <Link to="/kategorien">
            <Button size="lg">Spiel entdecken</Button>
          </Link>
          <Link to="/beitreten">
            <Button variant="secondary" size="lg">Raum beitreten</Button>
          </Link>
        </div>
      </section>

      <section className={styles.features}>
        <Card padding="lg" className={styles.featureCard}>
          <div className={styles.featureIcon}>🎯</div>
          <h3>Quiz & Wissen</h3>
          <p>Allgemeinwissen, Geografie, Gaming, Film, Sport und mehr</p>
        </Card>

        <Card padding="lg" className={styles.featureCard}>
          <div className={styles.featureIcon}>🔔</div>
          <h3>Buzzer-Spiele</h3>
          <p>Jeopardy, Wer ist das?, Erkenne den Song und mehr</p>
        </Card>

        <Card padding="lg" className={styles.featureCard}>
          <div className={styles.featureIcon}>🎲</div>
          <h3>Schätzen & Sortieren</h3>
          <p>Timeline, Higher or Lower, Schätz mal</p>
        </Card>

        <Card padding="lg" className={styles.featureCard}>
          <div className={styles.featureIcon}>🎭</div>
          <h3>Bluff & Lügen</h3>
          <p>Wer lügt am besten? und kreative Challenges</p>
        </Card>
      </section>

      <section className={styles.howItWorks}>
        <h2>So funktioniert's</h2>
        <div className={styles.steps}>
          <div className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <h3>Moderator werden</h3>
            <p>Melde dich an und erstelle einen Raum mit deinem Spiel</p>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <h3>Freunde einladen</h3>
            <p>Teile den Raumcode oder QR-Code mit deinen Freunden</p>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <h3>Spielen!</h3>
            <p>Bis zu 10 Spieler können gleichzeitig teilnehmen</p>
          </div>
        </div>
      </section>
    </div>
  );
}
