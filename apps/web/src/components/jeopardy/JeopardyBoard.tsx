// ============================================================
// Jeopardy Board Component
// Displays the interactive game board (moderator + player)
// Phase 5: Board layout matching Jeopardy style
// ============================================================

import React from 'react';
import styles from './JeopardyBoard.module.css';

export interface BoardCategory {
  name: string;
  clueCount: number;
}

export interface JeopardyBoardProps {
  categories: BoardCategory[];
  values: number[];
  playedFields: string[]; // "categoryIndex-value" keys
  currentField: { categoryIndex: number; value: number } | null;
  onFieldClick: (categoryIndex: number, value: number) => void;
  /** If true, fields are clickable (moderator). If false, read-only (player/spectator). */
  interactive: boolean;
  /** Highlight a field (e.g., currently open). */
  highlightedField?: { categoryIndex: number; value: number } | null;
}

export function JeopardyBoard({
  categories,
  values,
  playedFields,
  currentField,
  onFieldClick,
  interactive,
  highlightedField,
}: JeopardyBoardProps) {
  return (
    <div className={styles.board} role="grid" aria-label="Jeopardy-Spielfeld">
      {/* Category headers */}
      <div className={styles.headerRow} role="row">
        {categories.map((cat, ci) => (
          <div key={ci} className={styles.headerCell} role="columnheader">
            {cat.name || `Kategorie ${ci + 1}`}
          </div>
        ))}
      </div>

      {/* Field grid: values × categories */}
      {values.map((value) => (
        <div key={value} className={styles.valueRow} role="row">
          {categories.map((_cat, ci) => {
            const key = `${ci}-${value}`;
            const isPlayed = playedFields.includes(key);
            const isCurrent =
              currentField?.categoryIndex === ci && currentField?.value === value;
            const isHighlighted =
              highlightedField?.categoryIndex === ci &&
              highlightedField?.value === value;

            return (
              <button
                key={key}
                className={[
                  styles.cell,
                  isPlayed ? styles.played : '',
                  isCurrent ? styles.current : '',
                  isHighlighted ? styles.highlighted : '',
                  interactive && !isPlayed ? styles.interactive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={!interactive || isPlayed}
                onClick={() => !isPlayed && interactive && onFieldClick(ci, value)}
                role="gridcell"
                aria-label={
                  isPlayed
                    ? `Bereits gespielt: ${value} Punkte`
                    : `${value} Punkte – Kategorie ${ci + 1}`
                }
                aria-pressed={isCurrent}
              >
                <span className={styles.cellValue}>{value}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
