// ============================================================
// Categories Page – v0.3.x (aus kanonischem Katalog abgeleitet)
// Kategorien + Spielzahlen kommen aus @quiz/shared (Single Source of
// Truth) – keine hart eingegebenen Fantasiezahlen (Regelwerk §14).
// ============================================================

import { Link } from 'react-router-dom';
import { Card } from '@quiz/ui';
import { visibleCategories } from '../lib/catalog';
import styles from './CategoriesPage.module.css';

const categories = visibleCategories();

export function CategoriesPage() {
  return (
    <div className={`${styles.page} stagger`}>
      <h1 className={styles.title}>Spielekategorien</h1>
      <p className={styles.subtitle}>Wähle eine Kategorie und entdecke die Spiele</p>

      <div className={styles.grid}>
        {categories.map((cat) => (
          <Link to={`/kategorie/${cat.slug}`} key={cat.slug}>
            <Card interactive padding="none" className={styles.card} data-icon={cat.icon}>
              <span className={styles.icon}>{cat.icon}</span>
              <h2 className={styles.name}>{cat.name}</h2>
              <p className={styles.description}>{cat.description}</p>
              <span className={styles.count}>
                {cat.gameCount} {cat.gameCount === 1 ? 'Spiel' : 'Spiele'}
              </span>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
