// ============================================================
// Jeopardy Spectator Page
// Read-only view: board, question, scores, buzz winner
// Phase 5: Spectator UI — no buzzer, no judge buttons
// ============================================================

import { useParams } from 'react-router-dom';
import { useJeopardy } from '../hooks/useJeopardy';
import { JeopardyBoard } from '../components/jeopardy/JeopardyBoard';
import { JeopardyQuestion } from '../components/jeopardy/JeopardyQuestion';
import { Card, Badge } from '@quiz/ui';
import styles from './JeopardySpectatorPage.module.css';

export function JeopardySpectatorPage() {
  const { code } = useParams<{ code: string }>();
  const roomCode = code ?? '';

  const { connected, gameState, error, clearError } =
    useJeopardy(roomCode, 'VIEWER');

  const playerScoreList = Object.entries(gameState.scores).map(
    ([id, score]) => ({
      id,
      name: gameState.playerNames[id] ?? 'Unbekannt',
      score,
    })
  );

  const hasCurrentField = gameState.currentField !== null;
  const isGameEnded = gameState.phase === 'GAME_END';

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>
            🎬 Jeopardy – Board {gameState.boardNumber}
          </h1>
          <Badge variant="accent">{gameState.phase}</Badge>
        </div>
        <Badge variant={connected ? 'success' : 'danger'}>
          {connected ? 'Verbunden' : 'Getrennt'}
        </Badge>
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
          <button onClick={clearError} className={styles.errorClose}>
            ✕
          </button>
        </div>
      )}

      {/* Game end */}
      {isGameEnded && gameState.gameEnd && (
        <Card padding="lg" className={styles.gameEndCard}>
          <h2>🎉 Spiel beendet!</h2>
          <div className={styles.finalScores}>
            {gameState.gameEnd.finalScores.map((entry, idx) => (
              <div
                key={entry.playerId}
                className={`${styles.scoreRow} ${
                  gameState.gameEnd?.winnerIds.includes(entry.playerId)
                    ? styles.winner
                    : ''
                }`}
              >
                <span className={styles.rank}>
                  {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`}
                </span>
                <span className={styles.playerName}>{entry.playerName}</span>
                <span className={styles.finalScore}>{entry.score}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Main layout */}
      <div className={styles.grid}>
        {/* Board (non-interactive) */}
        <div className={styles.mainColumn}>
          <Card padding="md" className={styles.boardCard}>
            <JeopardyBoard
              categories={gameState.categories}
              values={gameState.values}
              playedFields={gameState.playedFields}
              currentField={
                hasCurrentField
                  ? {
                      categoryIndex: gameState.currentField!.categoryIndex,
                      value: gameState.currentField!.value,
                    }
                  : null
              }
              onFieldClick={() => {}}
              interactive={false}
              highlightedField={
                hasCurrentField
                  ? {
                      categoryIndex: gameState.currentField!.categoryIndex,
                      value: gameState.currentField!.value,
                    }
                  : null
              }
            />
          </Card>

          {/* Question (read-only) */}
          {hasCurrentField && gameState.currentField && (
            <JeopardyQuestion
              categoryIndex={gameState.currentField!.categoryIndex}
              value={gameState.currentField!.value}
              question={gameState.currentField!.question}
              phase={gameState.phase}
              buzzWinner={gameState.buzzWinner}
              stealWinner={gameState.stealWinner}
              reveal={
                gameState.reveal
                  ? {
                      ...gameState.reveal,
                      // Spectators also don't see the answer
                      answer: '••••••',
                    }
                  : null
              }
              stealResult={
                gameState.stealResult
                  ? {
                      ...gameState.stealResult,
                      // Spectators also don't see the answer
                      answer: '••••••',
                    }
                  : null
              }
              canBuzz={false}
              canStealBuzz={false}
              showBuzzControls={false}
              onBuzz={() => {}}
              onStealBuzz={() => {}}
              playerNames={gameState.playerNames}
            />
          )}

          {/* Waiting state */}
          {!hasCurrentField && !isGameEnded && (
            <Card padding="lg" className={styles.waitingCard}>
              <p>Warte auf nächste Frage...</p>
            </Card>
          )}
        </div>

        {/* Scores sidebar */}
        <div className={styles.sideColumn}>
          <Card padding="lg" className={styles.scoresCard}>
            <h2 className={styles.scoresTitle}>Spieler-Stände</h2>
            <div className={styles.scoreList}>
              {playerScoreList.length === 0 ? (
                <p className={styles.emptyScores}>Warte auf Spielstart...</p>
              ) : (
                [...playerScoreList]
                  .sort((a, b) => b.score - a.score)
                  .map((entry) => (
                    <div key={entry.id} className={styles.scoreRow}>
                      <span className={styles.playerName}>{entry.name}</span>
                      <span className={styles.scoreValue}>{entry.score}</span>
                    </div>
                  ))
              )}
            </div>
          </Card>

          {/* Current buzz winner */}
          {gameState.buzzWinner && (
            <Card padding="md" className={styles.buzzCard}>
              <h3>🔔 Aktueller Buzzer-Gewinner</h3>
              <p className={styles.buzzWinnerName}>
                {gameState.buzzWinner.playerName}
              </p>
            </Card>
          )}

          {gameState.stealWinner && (
            <Card padding="md" className={styles.stealCard}>
              <h3>⚡ Abstauber-Gewinner</h3>
              <p className={styles.buzzWinnerName}>
                {gameState.stealWinner.playerName}
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
