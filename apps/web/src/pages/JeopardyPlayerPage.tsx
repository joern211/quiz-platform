// ============================================================
// Jeopardy Player Page
// Player view: board (no answers), buzzer, scores
// Phase 5: Player UI — NO answers exposed
// ============================================================

import { useParams } from 'react-router-dom';
import { useJeopardy } from '../hooks/useJeopardy';
import { JeopardyBoard } from '../components/jeopardy/JeopardyBoard';
import { JeopardyQuestion } from '../components/jeopardy/JeopardyQuestion';
import { getSessionData } from '../lib/socket';
import { Card, Badge } from '@quiz/ui';
import styles from './JeopardyPlayerPage.module.css';

export function JeopardyPlayerPage() {
  const { code } = useParams<{ code: string }>();
  const roomCode = code ?? '';
  const session = getSessionData();
  const selfId = session.participationId ?? undefined;

  const { connected, gameState, error, clearError, actions } =
    useJeopardy(roomCode, 'PLAYER');

  const handleBuzz = () => {
    actions.buzz();
  };

  const handleStealBuzz = () => {
    actions.stealBuzz();
  };

  const playerScoreList = Object.entries(gameState.scores).map(
    ([id, score]) => ({
      id,
      name: gameState.playerNames[id] ?? 'Unbekannt',
      score,
      isSelf: id === selfId,
    })
  );

  const isBuzzOpen = gameState.phase === 'BUZZ_OPEN';
  const isStealOpen = gameState.phase === 'STEAL_OPEN';
  const isGameEnded = gameState.phase === 'GAME_END';
  const hasCurrentField = gameState.currentField !== null;

  // I can buzz if I'm in BUZZ_OPEN phase
  const canBuzz = isBuzzOpen;
  const canStealBuzz = isStealOpen && selfId !== gameState.stealExcludedId;

  const myScore = selfId ? gameState.scores[selfId] ?? 0 : 0;

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>Jeopardy – Board {gameState.boardNumber}</h1>
          <Badge variant="accent">{gameState.phase}</Badge>
        </div>
        <div className={styles.headerRight}>
          <span className={styles.myScore}>Deine Punkte: {myScore}</span>
          <Badge variant={connected ? 'success' : 'danger'}>
            {connected ? 'Verbunden' : 'Getrennt'}
          </Badge>
        </div>
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
          <button onClick={clearError} className={styles.errorClose}>
            ✕
          </button>
        </div>
      )}

      {/* Game end screen */}
      {isGameEnded && gameState.gameEnd && (
        <Card padding="lg" className={styles.gameEndCard}>
          <h2>Spiel beendet!</h2>
          <div className={styles.finalScores}>
            {gameState.gameEnd.finalScores.map((entry, idx) => (
              <div
                key={entry.playerId}
                className={`${styles.scoreRow} ${
                  entry.playerId === selfId ? styles.self : ''
                } ${
                  gameState.gameEnd?.winnerIds.includes(entry.playerId)
                    ? styles.winner
                    : ''
                }`}
              >
                <span className={styles.rank}>
                  {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`}
                </span>
                <span className={styles.playerName}>
                  {entry.playerName}
                  {entry.playerId === selfId && ' (Du)'}
                </span>
                <span className={styles.finalScore}>{entry.score}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Main layout */}
      <div className={styles.grid}>
        {/* Board — non-interactive for players */}
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

          {/* Question + buzzer */}
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
                      answer: '••••••', // NEVER expose answer to players
                    }
                  : null
              }
              stealResult={
                gameState.stealResult
                  ? {
                      ...gameState.stealResult,
                      answer: '••••••', // NEVER expose answer to players
                    }
                  : null
              }
              canBuzz={canBuzz}
              canStealBuzz={canStealBuzz}
              onBuzz={handleBuzz}
              onStealBuzz={handleStealBuzz}
              playerNames={gameState.playerNames}
              selfId={selfId}
            />
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
                    <div
                      key={entry.id}
                      className={`${styles.scoreRow} ${entry.isSelf ? styles.self : ''}`}
                    >
                      <span className={styles.playerName}>
                        {entry.name}
                        {entry.isSelf && ' (Du)'}
                      </span>
                      <span className={styles.scoreValue}>{entry.score}</span>
                    </div>
                  ))
              )}
            </div>
          </Card>

          {/* Status messages */}
          {isBuzzOpen && !hasCurrentField && (
            <Card padding="md" className={styles.statusCard}>
              <p>Warte auf Frage...</p>
            </Card>
          )}

          {isBuzzOpen && (
            <Card padding="md" className={styles.buzzerReadyCard}>
              <p>🔔 Warte auf Buzzer-Öffnung...</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
