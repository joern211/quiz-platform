// ============================================================
// Categories Page – v0.2.0
// ============================================================

import { Link } from 'react-router-dom';
import { Card } from '@quiz/ui';
import styles from './CategoriesPage.module.css';

const categories = [
  { slug: 'quiz-wissen',        name: 'Quiz & Wissen',        icon: '🎯',  description: 'Allgemeinwissen, Geografie, Gaming, Film und mehr',         gameCount: 19 },
  { slug: 'buzzer-reaktion',    name: 'Buzzer & Reaktion',    icon: '🔔',  description: 'Jeopardy, Song erkennen, Schnellraterundenspiele',               gameCount: 8  },
  { slug: 'schaetzen-sortieren',name: 'Schätzen & Sortieren', icon: '🎲',  description: 'Timeline, Higher or Lower, Schätz mal',                         gameCount: 7  },
  { slug: 'kreativ-schreiben',  name: 'Kreativ & Schreiben',  icon: '✏️',  description: 'Meme Battle, Story Chaos, Fake Definition',                       gameCount: 7  },
  { slug: 'bluff-taeuschung',   name: 'Bluff & Täuschung',    icon: '🎭',  description: 'Wer lügt am besten?, Wahrheit oder Fake?',                       gameCount: 6  },
  { slug: 'social-deduction',   name: 'Social Deduction',     icon: '🔍',  description: 'Undercover, Wer ist der Impostor?',                            gameCount: 5  },
  { slug: 'medien-erkennen',    name: 'Medien & Erkennen',    icon: '🖼️',  description: 'Logo-Quiz, Pokémon-Silhouetten, Emoji-Rätsel',                   gameCount: 10 },
  { slug: 'team-kooperation',   name: 'Team & Kooperation',   icon: '👥',  description: 'Team-Quiz, Tabu, Pantomime',                                    gameCount: 6  },
  { slug: 'freundesgruppe-insider', name: 'Freundesgruppe & Insider', icon: '💬', description: 'Wer würde eher?, Hot Seat, Freundschaftstest',        gameCount: 6  },
  { slug: 'minigames',          name: 'Minigames',            icon: '🎮',  description: 'Entweder Oder, Reaktionsklick, Memory-Duell',                   gameCount: 6  },
  { slug: 'meta-spielmodi',     name: 'Meta-Spielmodi',       icon: '🏆',  description: 'Quiz-Abend, Chaos-Modus, Turniermodus',                         gameCount: 7  },
];

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
