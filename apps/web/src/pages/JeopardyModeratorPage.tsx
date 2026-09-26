// ============================================================
// Jeopardy Moderator Page
// Full game control: board, question, buzzer, judge, next
// Phase 5: Moderator view with secret answer
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useJeopardy } from '../hooks/useJeopardy';
import { JeopardyBoard } from '../components/jeopardy/JeopardyBoard';
import { JeopardyQuestion } from '../components/jeopardy/JeopardyQuestion';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './JeopardyModeratorPage.module.css';

export function JeopardyModeratorPage() {
  const { code } = useParams<{ code: string }>();
  const roomCode = code ?? '';
  const navigate = useNavigate();
  const { connected, gameState, secretAnswer, error, clearError, actions } =
    useJeopardy(roomCode, 'MODERATOR');

  // Redirect to lobby if game not started
  useEffect(() => {
    if (gameState.phase === 'INTRO' || gameState.phase === 'GAME_END') {
      // Game not started yet or ended
    }
  }, [gameState.phase]);

  const handleFieldClick = (categoryIndex: number, value: number) => {
    actions.openField(gameState.boardNumber, categoryIndex, value);
  };

  const handleJudgeCorrect = () => actions.judge(true);
  const handleJudgeWrong = () => actions.judge(false);
  const handleStealJudgeCorrect = () => actions.stealJudge(true);
  const handleStealJudgeWrong = () => actions.stealJudge(false);
  const handleNext = () => actions.next();

  const handleSwitchBoard = () => {
    const nextBoard = gameState.boardNumber === 1 ? 2 : 1;
    actions.switchBoard(nextBoard as 1 | 2);
  };

  const playerScoreList = Object.entries(gameState.scores).map(
    ([id, score]) => ({
      id,
      name: gameState.playerNames[id] ?? 'Unbekannt',
      score,
    })
  );

  const isGameEnded = gameState.phase === 'GAME_END';
  const isBoardComplete = gameState.phase === 'BOARD_COMPLETE';
  const hasCurrentField =
    gameState.currentField !== null;
  const isBuzzLocked =
    gameState.phase === 'BUZZ_LOCKED';
  const isStealLocked =
    gameState.phase === 'STEAL_LOCKED';
  const isFieldDone = gameState.phase === 'FIELD_DONE';

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>
            Jeopardy – Board {gameState.boardNumber}
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

      {/* Game end screen */}
      {isGameEnded && gameState.gameEnd && (
        <Card padding="lg" className={styles.gameEndCard}>
          <h2>Spiel beendet!</h2>
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
          <Button onClick={() => navigate(`/moderator/raum/${roomCode}/ergebnis`)}>
            Zum Ergebnis
          </Button>
        </Card>
      )}

      {/* Main layout */}
      <div className={styles.grid}>
        {/* Left: Board + Controls */}
        <div className={styles.mainColumn}>
          {/* Board */}
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
              onFieldClick={handleFieldClick}
              interactive={gameState.phase === 'SELECTING'}
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

          {/* Question + judge controls */}
          {hasCurrentField && gameState.currentField && (
            <div className={styles.questionSection}>
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
                        answer: gameState.reveal.answer ?? '••••••',
                      }
                    : null
                }
                stealResult={
                  gameState.stealResult
                    ? {
                        ...gameState.stealResult,
                        answer: gameState.stealResult.answer ?? '••••••',
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

              {/* Secret answer (MODERATOR ONLY) */}
              {secretAnswer && (
                <Card padding="md" className={styles.secretCard}>
                  <div className={styles.secretHeader}>
                    🔒 Geheime Lösung (nur Moderator)
                  </div>
                  <div className={styles.secretAnswer}>{secretAnswer}</div>
                </Card>
              )}

              {/* Judge buttons (main round) */}
              {isBuzzLocked && (
                <div className={styles.judgeControls}>
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={handleJudgeCorrect}
                  >
                    ✓ RICHTIG (+{gameState.currentField!.value})
                  </Button>
                  <Button
                    variant="danger"
                    size="lg"
                    onClick={handleJudgeWrong}
                  >
                    ✗ FALSCH (−{Math.round(gameState.currentField!.value / 2)})
                  </Button>
                </div>
              )}

              {/* Judge buttons (steal round) */}
              {isStealLocked && (
                <div className={styles.judgeControls}>
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={handleStealJudgeCorrect}
                  >
                    ✓ RICHTIG (+{Math.round(gameState.currentField!.value / 2)})
                  </Button>
                  <Button
                    variant="danger"
                    size="lg"
                    onClick={handleStealJudgeWrong}
                  >
                    ✗ FALSCH (−{Math.round(gameState.currentField!.value / 2)})
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Board-switch or next button */}
          {(isFieldDone || isBoardComplete) && (
            <div className={styles.nextControls}>
              {isBoardComplete ? (
                <Button
                  size="lg"
                  onClick={handleSwitchBoard}
                >
                  Board {gameState.boardNumber === 1 ? '1' : '2'} abgeschlossen → {gameState.boardNumber === 1 ? 'Board 2' : 'Spielende'}
                </Button>
              ) : (
                <Button size="lg" onClick={handleNext}>
                  → Nächste Frage
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Right: Scores */}
        <div className={styles.sideColumn}>
          <Card padding="lg" className={styles.scoresCard}>
            <h2 className={styles.scoresTitle}>Spieler-Stände</h2>
            <div className={styles.scoreList}>
              {playerScoreList.length === 0 ? (
                <p className={styles.emptyScores}>Noch keine Punkte</p>
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

          {/* Buzzer status */}
          {hasCurrentField && gameState.buzzWinner && (
            <Card padding="md" className={styles.buzzerStatus}>
              <h3>🔔 Buzzer-Gewinner</h3>
              <p className={styles.buzzWinnerName}>
                {gameState.buzzWinner.playerName}
              </p>
            </Card>
          )}

          {hasCurrentField && gameState.stealWinner && (
            <Card padding="md" className={styles.buzzerStatus}>
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
