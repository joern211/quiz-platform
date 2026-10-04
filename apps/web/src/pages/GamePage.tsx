// ============================================================
// Game Page (select role: Moderator, Player, Viewer)
//
// Alle Spiel-Daten kommen aus @quiz/shared (Single Source of Truth,
// Regelwerk §14). Startbarkeit ist EHRlich: nur AVAILABLE/BETA mit
// echter Engine-Registry darf einen Raum erstellen (Regelwerk §13.1).
// ============================================================

import { useParams, Link, useNavigate } from 'react-router-dom';
import { Card, Button, Badge } from '@quiz/ui';
import { findManifest, categoryName } from '../lib/catalog';
import { isStartableGame, type GameStatus } from '@quiz/shared';
import styles from './GamePage.module.css';

const statusBadge: Record<GameStatus, { label: string; variant: 'success' | 'warning' | 'muted' }> = {
  AVAILABLE: { label: 'Verfügbar', variant: 'success' },
  BETA: { label: 'Beta', variant: 'warning' },
  PLANNED: { label: 'Geplant', variant: 'muted' },
  HIDDEN: { label: 'Intern', variant: 'muted' },
};

export function GamePage() {
  const { gameSlug } = useParams<{ gameSlug: string }>();
  const navigate = useNavigate();
  const manifest = findManifest(gameSlug);

  if (!manifest) {
    return (
      <div className={styles.page}>
        <div className={styles.notFound}>
          <h1>Spiel nicht gefunden</h1>
          <p>Das gesuchte Spiel existiert nicht oder ist noch nicht verfügbar.</p>
          <Link to="/kategorien">
            <Button>Zu den Kategorien</Button>
          </Link>
        </div>
      </div>
    );
  }

  const startable = isStartableGame(manifest.status);
  const tags: string[] = [];
  if (manifest.hasBuzzer) tags.push('Buzzer');
  if (manifest.hasTeams) tags.push('Teams');
  if (manifest.hasCamera) tags.push('Kamera');
  if (manifest.hasAudio) tags.push('Audio');

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Link to={`/kategorie/${manifest.category}`} className={styles.backLink}>
          ← Zurück
        </Link>

        <div className={styles.titleRow}>
          <h1 className={styles.title}>{manifest.name}</h1>
          <Badge variant={statusBadge[manifest.status].variant}>{statusBadge[manifest.status].label}</Badge>
        </div>

        <div className={styles.tags}>
          {tags.map(tag => (
            <Badge key={tag} variant="accent">{tag}</Badge>
          ))}
          <span className={styles.meta}>👥 {manifest.minPlayers}-{manifest.maxPlayers} Spieler</span>
          <span className={styles.meta}>⏱️ ~{manifest.estimatedDurationMinutes} Min</span>
        </div>
      </div>

      <div className={styles.content}>
        <Card padding="lg" className={styles.rulesCard}>
          <h2>Über das Spiel</h2>
          <p>{manifest.description}</p>
          <p className={styles.category}>Kategorie: {categoryName(manifest.category)}</p>
        </Card>

        {!startable && (
          <Card padding="lg" className={styles.rulesCard}>
            <h2>Noch nicht spielbar</h2>
            <p>
              {manifest.name} ist im kanonischen Katalog festgelegt (Regelwerk §14), aber es
              existiert noch keine startbare Engine. Es kann daher noch keinen Raum geben.
            </p>
          </Card>
        )}

        <div className={styles.roles}>
          <h2>Als was möchtest du teilnehmen?</h2>

          <div className={styles.roleGrid}>
            <Card
              interactive={startable}
              padding="lg"
              className={styles.roleCard}
              onClick={() => { if (startable) navigate(`/moderator/vorbereitung/${manifest.slug}`); }}
            >
              <div className={styles.roleIcon}>🎮</div>
              <h3>Moderator</h3>
              <p>{startable ? 'Erstelle einen Raum, konfiguriere das Spiel und führe die Runde' : 'Noch nicht verfügbar (Engine in Arbeit)'}</p>
              <ul className={styles.roleFeatures}>
                <li>✓ Spiel konfigurieren</li>
                <li>✓ Fragen auswählen</li>
                <li>✓ Ergebnisse sehen</li>
              </ul>
              <Button fullWidth disabled={!startable}>Raum erstellen</Button>
            </Card>

            <Card interactive padding="lg" className={styles.roleCard} onClick={() => navigate('/beitreten')}>
              <div className={styles.roleIcon}>👤</div>
              <h3>Spieler</h3>
              <p>Tritt einem bestehenden Raum bei und spiele mit</p>
              <ul className={styles.roleFeatures}>
                <li>✓ Mitraten und antworten</li>
                <li>✓ Joker verwenden</li>
                <li>✓ Punkte sammeln</li>
              </ul>
              <Button variant="secondary" fullWidth>Raum beitreten</Button>
            </Card>

            <Card interactive padding="lg" className={styles.roleCard} onClick={() => navigate('/zuschauen')}>
              <div className={styles.roleIcon}>👁️</div>
              <h3>Zuschauer</h3>
              <p>Schau dem Spiel zu, ohne selbst zu spielen</p>
              <ul className={styles.roleFeatures}>
                <li>✓ Spielverlauf &amp; Ergebnisse live</li>
                <li>✓ Keine Eingabe</li>
                <li>✓ Perfekt zum Streamen</li>
              </ul>
              <Button variant="secondary" fullWidth>Zuschauen</Button>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
