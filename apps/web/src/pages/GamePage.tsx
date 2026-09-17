// ============================================================
// Game Page (select role: Moderator, Player, Viewer)
// ============================================================

import { useParams, Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './GamePage.module.css';

// Mock game data
const games: Record<string, any> = {
  geo: {
    slug: 'geo',
    name: 'Geografie-Quiz',
    category: 'Quiz & Wissen',
    shortRules: 'Beantworte Fragen zu Hauptstädten, Flaggen, Flüssen und Bergen. Wähle zwischen 4 Optionen.',
    longRules: `Das Geografie-Quiz ist das perfekte Spiel für Liebhaber von Ländern, Hauptstädten und geografischem Wissen.

Jede Frage bietet 4 Antwortoptionen, von denen nur eine richtig ist. Du hast 20 Sekunden Zeit (konfigurierbar).

Joker helfen dir:
• 50/50: Zwei falsche Antworten werden entfernt
• Spy: Zeigt die Verteilung der anderen Spieler
• Risk: Verdoppelt sowohl Gewinn als auch Verlust`,
    playerCount: { min: 2, max: 10 },
    duration: '15-30 Min',
    hasBuzzer: false,
    hasTeams: true,
    hasCamera: false,
    hasAudio: false,
    status: 'BETA',
    categories: ['Hauptstädte', 'Flaggen', 'Allgemein', 'Sprachen', 'Flüsse & Berge'],
  },
  jeopardy: {
    slug: 'jeopardy',
    name: 'Jeopardy',
    category: 'Buzzer & Reaktion',
    shortRules: 'Wähle ein Feld, beantworte die Frage — oder schnappe sie dir als Abstauber!',
    longRules: `Jeopardy mit zwei Boards zu je 6 Kategorien und 5 Feldern (100-500 bzw. 200-1000 Punkte).

Ablauf:
1. Auswahlspieler wählt ein Feld
2. Moderator zeigt die Frage
3. Auswahlspieler antwortet verbal
4. Richtig: voller Punkte | Falsch: -50% + Abstauberphase
5. In der Abstauberphase dürfen alle buzzern`,
    playerCount: { min: 2, max: 10 },
    duration: '30-45 Min',
    hasBuzzer: true,
    hasTeams: true,
    hasCamera: false,
    hasAudio: false,
    status: 'BETA',
  },
  'wer-ist-das': {
    slug: 'wer-ist-das',
    name: 'Wer ist das?',
    category: 'Buzzer & Reaktion',
    shortRules: 'Errate zwei verschmolzene Personen. Erster Buzzer gewinnt!',
    longRules: `Zwei Personen werden zu einem Fusionbild verschmolzen. Errate beide!

Ablauf:
1. Buzzer öffnet
2. Erster Spieler buzzert und antwortet
3. Moderator bewertet: beide richtig +3, falsch -1
4. Hinweis "1 Person reicht" senkt auf +1 pro Person`,
    playerCount: { min: 2, max: 10 },
    duration: '20-30 Min',
    hasBuzzer: true,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    status: 'BETA',
  },
  timeline: {
    slug: 'timeline',
    name: 'Timeline',
    category: 'Schätzen & Sortieren',
    shortRules: 'Ordne Ereignisse in die richtige Reihenfolge. 3 Leben — wer hält durch?',
    longRules: `Platziere Ereignisse in der richtigen zeitlichen oder numerischen Reihenfolge.

Ablauf:
1. Ein Element erscheint
2. Spieler entscheidet, wo es hingehört
3. Richtig: eingefügt und enthüllt | Falsch: verliere ein Leben
4. Bei 0 Leben: KO und ausscheiden
5. Letzter verbleibender Spieler gewinnt`,
    playerCount: { min: 2, max: 10 },
    duration: '20-30 Min',
    hasBuzzer: false,
    hasTeams: true,
    hasCamera: false,
    hasAudio: false,
    status: 'BETA',
  },
  luegen: {
    slug: 'luegen',
    name: 'Wer lügt am besten?',
    category: 'Bluff & Täuschung',
    shortRules: 'Schreibe eine falsche Antwort und täusche die anderen. Wer wählt die echte Antwort?',
    longRules: `Alle Spieler schreiben eine falsche Antwort auf eine Frage. Die echte Antwort wird untergemischt.

Ablauf:
1. Frage wird gezeigt
2. Jeder schreibt eine plausible Lüge
3. Alle Antworten werden gemischt
4. Spieler voten für die vermeintlich echte Antwort
5. Wer die echte wählt: +1 | Wessen Lüge gewählt wird: +1 pro Stimme`,
    playerCount: { min: 3, max: 10 },
    duration: '20-30 Min',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    status: 'BETA',
  },
  song: {
    slug: 'song',
    name: 'Erkenne den Song',
    category: 'Buzzer & Reaktion',
    shortRules: 'Höre einen Songclip und buzzere zuerst. Wer erkennt Interpret und Titel?',
    longRules: `Ein Song wird abgespielt. Sei der Erste, der buzzert!

Ablauf:
1. Audio startet, Buzzer ist offen
2. Erster Buzzer stoppt/dimmt das Audio
3. Gewinner nennt Interpret und Titel
4. Moderator bewertet: richtig +1 | falsch: Buzzer öffnet erneut`,
    playerCount: { min: 2, max: 10 },
    duration: '20-30 Min',
    hasBuzzer: true,
    hasTeams: false,
    hasCamera: false,
    hasAudio: true,
    status: 'BETA',
  },
};

export function GamePage() {
  const { gameSlug } = useParams<{ gameSlug: string }>();
  const navigate = useNavigate();
  const [game, setGame] = useState<any>(null);

  useEffect(() => {
    const gameData = games[gameSlug || ''];
    if (gameData) {
      setGame(gameData);
    }
  }, [gameSlug]);

  if (!game) {
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

  const tags = [];
  if (game.hasBuzzer) tags.push('Buzzer');
  if (game.hasTeams) tags.push('Teams');
  if (game.hasCamera) tags.push('Kamera');
  if (game.hasAudio) tags.push('Audio');

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Link to={`/kategorie/${game.category.toLowerCase().replace(/ & /g, '-')}`} className={styles.backLink}>
          ← Zurück
        </Link>
        
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{game.name}</h1>
          <Badge variant="success">Verfügbar</Badge>
        </div>

        <div className={styles.tags}>
          {tags.map(tag => (
            <Badge key={tag} variant="accent">{tag}</Badge>
          ))}
          <span className={styles.meta}>👥 {game.playerCount.min}-{game.playerCount.max} Spieler</span>
          <span className={styles.meta}>⏱️ {game.duration}</span>
        </div>
      </div>

      <div className={styles.content}>
        <Card padding="lg" className={styles.rulesCard}>
          <h2>Spielregeln</h2>
          <pre className={styles.rules}>{game.longRules}</pre>
        </Card>

        <div className={styles.roles}>
          <h2>Als was möchtest du teilnehmen?</h2>
          
          <div className={styles.roleGrid}>
            <Card interactive padding="lg" className={styles.roleCard} onClick={() => navigate(`/moderator/vorbereitung/${game.slug}`)}>
              <div className={styles.roleIcon}>🎮</div>
              <h3>Moderator</h3>
              <p>Erstelle einen Raum, konfiguriere das Spiel und führe die Runde</p>
              <ul className={styles.roleFeatures}>
                <li>✓ Spiel konfigurieren</li>
                <li>✓ Fragen auswählen</li>
                <li>✓ Ergebnisse sehen</li>
              </ul>
              <Button fullWidth>Raum erstellen</Button>
            </Card>

            <Card interactive padding="lg" className={styles.roleCard} onClick={() => navigate(`/beitreten`)}>
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

            <Card interactive padding="lg" className={styles.roleCard} onClick={() => navigate(`/zuschauen`)}>
              <div className={styles.roleIcon}>👁️</div>
              <h3>Zuschauer</h3>
              <p>Schau dem Spiel zu, ohne selbst zu spielen</p>
              <ul className={styles.roleFeatures}>
                <li>✓ Alles sehen</li>
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
