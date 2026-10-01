// ============================================================
// Category Page (list games in a category)
// Spiele + Namen kommen aus @quiz/shared (Single Source of Truth,
// Regelwerk §14) – keine Mock-Daten, keine doppelten Hardcodes.
// ============================================================

import { useParams, Link } from 'react-router-dom';
import { GameCard } from '../components/GameCard';
import { gamesByCategory, categoryName, visibleCategories } from '../lib/catalog';
import styles from './CategoryPage.module.css';

export function CategoryPage() {
  const { categorySlug } = useParams<{ categorySlug: string }>();
  const category = categorySlug ?? '';
  const games = gamesByCategory(category);
  const categoryNameResolved = categoryName(category) || visibleCategories().find(c => c.slug === category)?.name || 'Unbekannt';

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Link to="/kategorien" className={styles.backLink}>← Alle Kategorien</Link>
        <h1 className={styles.title}>{categoryNameResolved}</h1>
        <p className={styles.subtitle}>
          {games.length} {games.length === 1 ? 'Spiel' : 'Spiele'}
        </p>
      </div>

      {games.length > 0 ? (
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
