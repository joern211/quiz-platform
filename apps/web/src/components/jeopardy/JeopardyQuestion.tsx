// ============================================================
// Jeopardy Question Component
// Shows the current question/clue and buzzer state
// Phase 5: Player buzzer + reveal states
// ============================================================

import React from 'react';
import { Button, Badge, Card } from '@quiz/ui';
import styles from './JeopardyQuestion.module.css';

export interface JeopardyQuestionProps {
  categoryIndex: number;
  value: number;
  question: string;
  /** The current game phase */
  phase:
    | 'INTRO'
    | 'SELECTING'
    | 'BUZZ_OPEN'
    | 'BUZZ_LOCKED'
    | 'STEAL_OPEN'
    | 'STEAL_LOCKED'
    | 'FIELD_DONE'
    | 'BOARD_COMPLETE'
    | 'GAME_END';
  /** Who buzzed in (main round) */
  buzzWinner?: { playerId: string; playerName: string } | null;
  /** Who won the steal attempt */
  stealWinner?: { playerId: string; playerName: string } | null;
  /** Reveal data (after judgment) */
  reveal?: {
    correct: boolean;
    playerName: string;
    delta: number;
    answer: string; // may be masked with ••••••
    scores: Record<string, number>;
  } | null;
  /** Steal result (after steal judgment) */
  stealResult?: {
    thiefCorrect: boolean;
    thiefDelta: number;
    answer: string;
    scores: Record<string, number>;
  } | null;
  /** Is this client's buzz button active? */
  canBuzz: boolean;
  /** Is this client's steal-buzz button active? */
  canStealBuzz: boolean;
  /** Whether this role can see the buzzer controls at all. */
  showBuzzControls?: boolean;
  /** Callback when player buzzes */
  onBuzz: () => void;
  /** Callback when player steals buzz */
  onStealBuzz: () => void;
  /** Player names map */
  playerNames: Record<string, string>;
  /** Self participation ID */
  selfId?: string;
}

export function JeopardyQuestion({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  categoryIndex,
  value,
  question,
  phase,
  buzzWinner,
  stealWinner,
  reveal,
  stealResult,
  canBuzz,
  canStealBuzz,
  showBuzzControls = true,
  onBuzz,
  onStealBuzz,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  playerNames,
  selfId,
}: JeopardyQuestionProps) {
  const isBuzzOpen = phase === 'BUZZ_OPEN';
  const isStealOpen = phase === 'STEAL_OPEN';
  const isBuzzLocked = phase === 'BUZZ_LOCKED';
  const isStealLocked = phase === 'STEAL_LOCKED';
  const isRevealed = phase === 'FIELD_DONE';

  const formatScore = (delta: number) =>
    delta >= 0 ? `+${delta}` : `${delta}`;

  const iWonBuzz =
    buzzWinner && selfId && buzzWinner.playerId === selfId;
  const iWonSteal =
    stealWinner && selfId && stealWinner.playerId === selfId;

  return (
    <Card padding="lg" className={styles.questionCard}>
      <div className={styles.header}>
        <Badge variant="accent">Frage · {value} Punkte</Badge>
        {isBuzzOpen && !reveal && (
          <Badge variant="warning" className={styles.buzzerBadge}>
            🔔 Buzzer offen!
          </Badge>
        )}
        {isStealOpen && (
          <Badge variant="danger" className={styles.buzzerBadge}>
            ⚡ Abstauber-Phase!
          </Badge>
        )}
      </div>

      {/* Question text */}
      <blockquote className={styles.question}>
        <p>{question}</p>
      </blockquote>

      {/* Buzzer (main round) */}
      {showBuzzControls && isBuzzOpen && !reveal && (
        <div className={styles.buzzerSection}>
          <Button
            size="lg"
            onClick={onBuzz}
            disabled={!canBuzz}
            className={styles.buzzerBtn}
            aria-label="Jetzt buzzen!"
          >
            🔔 JETZT BUZZEN!
          </Button>
          {!canBuzz && (
            <p className={styles.buzzerHint}>
              Warten auf andere Spieler...
            </p>
          )}
        </div>
      )}

      {/* Steal buzzer */}
      {showBuzzControls && isStealOpen && !reveal && (
        <div className={styles.buzzerSection}>
          <Button
            size="lg"
            variant="danger"
            onClick={onStealBuzz}
            disabled={!canStealBuzz}
            className={styles.buzzerBtn}
            aria-label="Abstauber-Buzzer"
          >
            ⚡ ABSTAUBER BUZZEN!
          </Button>
          {!canStealBuzz && (
            <p className={styles.buzzerHint}>
              Warten auf Abstauber...
            </p>
          )}
        </div>
      )}

      {/* Buzz winner (main round) */}
      {(isBuzzLocked || (reveal && !stealResult)) && buzzWinner && (
        <div className={styles.winnerBanner}>
          <span className={styles.winnerIcon}>🔔</span>
          <span className={styles.winnerName}>
            {buzzWinner.playerName}
            {iWonBuzz && ' (Du!)'}
          </span>
          <span className={styles.waitingText}>antwortet...</span>
        </div>
      )}

      {/* Steal winner */}
      {isStealLocked && stealWinner && (
        <div className={styles.winnerBanner}>
          <span className={styles.winnerIcon}>⚡</span>
          <span className={styles.winnerName}>
            {stealWinner.playerName}
            {iWonSteal && ' (Du!)'}
          </span>
          <span className={styles.waitingText}>beantwortet die Frage...</span>
        </div>
      )}

      {/* Reveal result */}
      {isRevealed && reveal && (
        <div className={styles.revealSection}>
          <div
            className={`${styles.resultBadge} ${
              reveal.correct ? styles.correct : styles.wrong
            }`}
          >
            {reveal.correct ? '✓ Richtig!' : '✗ Falsch'}
          </div>

          {reveal.answer && reveal.answer !== '••••••' && (
            <div className={styles.answerReveal}>
              <strong>Antwort:</strong> {reveal.answer}
            </div>
          )}

          <div className={styles.scoreChange}>
            <span>{reveal.playerName}:</span>
            <span
              className={
                reveal.delta >= 0 ? styles.scoreUp : styles.scoreDown
              }
            >
              {formatScore(reveal.delta)} Punkte
            </span>
          </div>
        </div>
      )}

      {/* Steal result */}
      {isRevealed && stealResult && (
        <div className={styles.stealResultSection}>
          <div className={styles.stealHeader}>Abstauber-Ergebnis</div>
          <div
            className={`${styles.resultBadge} ${
              stealResult.thiefCorrect ? styles.correct : styles.wrong
            }`}
          >
            {stealResult.thiefCorrect ? '✓ Abstauben erfolgreich!' : '✗ Abstauben falsch!'}
          </div>

          {stealResult.answer && stealResult.answer !== '••••••' && (
            <div className={styles.answerReveal}>
              <strong>Lösung:</strong> {stealResult.answer}
            </div>
          )}

          <div className={styles.scoreChange}>
            <span>Abstauber:</span>
            <span
              className={
                stealResult.thiefDelta >= 0 ? styles.scoreUp : styles.scoreDown
              }
            >
              {formatScore(stealResult.thiefDelta)} Punkte
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
