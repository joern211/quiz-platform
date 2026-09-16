// ============================================================
// Category Page (list games in a category)
// ============================================================

import { useParams, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { GameCard } from '../components/GameCard';
import { Badge } from '@quiz/ui';
import styles from './CategoryPage.module.css';

// Mock game data - in production this would come from the API
const gamesByCategory: Record<string, any[]> = {
  'quiz-wissen': [
    {
      slug: 'geo',
      name: 'Geografie-Quiz',
      category: 'Quiz & Wissen',
      shortRules: 'Beantworte Fragen zu Hauptstädten, Flaggen, Flüssen und mehr. 4 Antwortoptionen, Joker verfügbar.',
      playerCount: { min: 2, max: 10 },
      duration: '15-30 Min',
      hasBuzzer: false,
      hasTeams: true,
      hasCamera: false,
      hasAudio: false,
      status: 'AVAILABLE',
    },
    {
      slug: 'jeopardy',
      name: 'Jeopardy',
      category: 'Buzzer & Reaktion',
      shortRules: 'Wähle ein Feld, beantworte die Frage und versuche zu bluffen. Wer hat den höchsten Score?',
      playerCount: { min: 2, max: 10 },
      duration: '30-45 Min',
      hasBuzzer: true,
      hasTeams: true,
      hasCamera: false,
      hasAudio: false,
      status: 'AVAILABLE',
    },
  ],
  'buzzer-reaktion': [
    {
      slug: 'wer-ist-das',
      name: 'Wer ist das?',
      category: 'Buzzer & Reaktion',
      shortRules: 'Errate welche zwei Personen auf dem verschmolzenen Bild zu sehen sind. Erster Buzzer gewinnt!',
      playerCount: { min: 2, max: 10 },
      duration: '20-30 Min',
      hasBuzzer: true,
      hasTeams: false,
      hasCamera: false,
      hasAudio: false,
      status: 'AVAILABLE',
    },
  ],
  'schaetzen-sortieren': [
    {
      slug: 'timeline',
      name: 'Timeline',
      category: 'Schätzen & Sortieren',
      shortRules: 'Ordne Ereignisse oder Zahlen in die richtige Reihenfolge. 3 Leben — wer hält am längsten durch?',
      playerCount: { min: 2, max: 10 },
      duration: '20-30 Min',
      hasBuzzer: false,
      hasTeams: true,
      hasCamera: false,
      hasAudio: false,
      status: 'AVAILABLE',
    },
  ],
  'bluff-taeuschung': [
    {
      slug: 'luegen',
      name: 'Wer lügt am besten?',
      category: 'Bluff & Täuschung',
      shortRules: 'Schreibe eine falsche Antwort und versuche zu täuschen. Wer wählt die echte Antwort?',
      playerCount: { min: 3, max: 10 },
      duration: '20-30 Min',
      hasBuzzer: false,
      hasTeams: false,
      hasCamera: false,
      hasAudio: false,
      status: 'AVAILABLE',
    },
  ],
  'kreativ-schreiben': [],
  'social-deduction': [],
  'medien-erkennen': [],
  'team-kooperation': [],
  'freundesgruppe-insider': [],
  'minigames': [],
  'meta-spielmodi': [],
};

const categoryNames: Record<string, string> = {
  'quiz-wissen': 'Quiz & Wissen',
  'buzzer-reaktion': 'Buzzer & Reaktion',
  'schaetzen-sortieren': 'Schätzen & Sortieren',
  'kreativ-schreiben': 'Kreativ & Schreiben',
  'bluff-taeuschung': 'Bluff & Täuschung',
  'social-deduction': 'Social Deduction',
  'medien-erkennen': 'Medien & Erkennen',
  'team-kooperation': 'Team & Kooperation',
  'freundesgruppe-insider': 'Freundesgruppe & Insider',
  'minigames': 'Minigames',
  'meta-spielmodi': 'Meta-Spielmodi',
};

export function CategoryPage() {
  const { categorySlug } = useParams<{ categorySlug: string }>();
  const [games, setGames] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate API fetch
    setLoading(true);
    setTimeout(() => {
      const categoryGames = gamesByCategory[categorySlug || ''] || [];
      setGames(categoryGames);
      setLoading(false);
    }, 300);
  }, [categorySlug]);

  const categoryName = categoryNames[categorySlug || ''] || 'Unbekannt';

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Link to="/kategorien" className={styles.backLink}>← Alle Kategorien</Link>
        <h1 className={styles.title}>{categoryName}</h1>
        <p className={styles.subtitle}>
          {games.length} {games.length === 1 ? 'Spiel' : 'Spiele'} verfügbar
        </p>
      </div>

      {loading ? (
        <div className={styles.loading}>Laden...</div>
      ) : games.length > 0 ? (
        <div className={styles.grid}>
          {games.map((game) => (
            <GameCard key={game.slug} game={game} />
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          <p>Noch keine Spiele in dieser Kategorie.</p>
          <p>Schau bald wieder vorbei!</p>
        </div>
      )}
    </div>
  );
}
