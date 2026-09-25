// ============================================================
// Player Game Page (Geo Quiz)
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { getSocket, connectSocket, disconnectSocket } from '../lib/socket';
import { getSession } from '../lib/sessionStore';
import { Card, Button, Badge } from '@quiz/ui';
import { Timer } from '@quiz/ui';
import styles from './PlayerGamePage.module.css';

export function PlayerGamePage() {
  const { code } = useParams<{ code: string }>();
  const roomCode = code ?? '';
  const navigate = useNavigate();
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);
  const [connected, setConnected] = useState(false);
  const [, setPhase] = useState<string>('WAITING');
  const [question, setQuestion] = useState<any>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [endsAt, setEndsAt] = useState<number>(0);
  const [score, setScore] = useState(0);
  const [jokers, setJokers] = useState({
    used5050: false,
    usedSpy: false,
    usedRisk: false,
  });
  const [eliminatedOptions, setEliminatedOptions] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [answerSubmitted, setAnswerSubmitted] = useState(false);
  const [actionError, setActionError] = useState('');
  const session = getSession();
  const rejoinToken = session.rejoinToken;
  const participationId = session.participationId;

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    connectSocket();

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('game:end', (data) => {
      if (data.status === 'ENDED') {
        navigate(`/raum/${roomCode}/ergebnis`);
      }
    });

    socket.on('geo:question', (data) => {
      setQuestion(data.question);
      setEndsAt(data.timerEndMs);
      setSelectedOption(null);
      setLocked(false);
      setRevealed(false);
      setEliminatedOptions([]);
      setAnswerSubmitted(false);
      setActionError('');
      setPhase('INPUT_OPEN');
    });

    socket.on('geo:answered', () => {
      // Another player answered - info only
    });

    socket.on('geo:joker:5050:result', (data) => {
      setEliminatedOptions(data.eliminated);
      setJokers(prev => ({ ...prev, used5050: true }));
    });

    socket.on('geo:joker:risk:result', () => {
      setJokers(prev => ({ ...prev, usedRisk: true }));
    });

    socket.on('geo:joker:spy:result', () => {
      setJokers(prev => ({ ...prev, usedSpy: true }));
    });

    socket.on('geo:reveal', (data) => {
      setRevealed(true);
      setResult(data);
      
      // Update score from result - use session participationId
      const myResult = data.scores.find((scoreResult) => scoreResult.participationId === participationId);
      if (myResult) {
        setScore(myResult.score);
      }
    });

    socket.on('buzz:won', (_data) => {
      // Someone buzzed - only relevant if this client buzzed
    });

    // Subscribe to room
    socket.emit('room:subscribe', { roomCode, rejoinToken: rejoinToken ?? undefined }, (response) => {
      if (!response.success) setActionError(`Raumverbindung fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
    });

    return () => { disconnectSocket(); };
  }, [navigate, participationId, rejoinToken, roomCode]);

  const handleSelectOption = (optionId: string) => {
    if (locked) return;
    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    
    setSelectedOption(optionId);
    setLocked(true);
    
    socketRef.current.emit('geo:answer', {
      roomCode,
      optionId,
    }, (response) => {
      if (response.success) {
        setAnswerSubmitted(true);
      } else {
        setSelectedOption(null);
        setLocked(false);
        setActionError('Antwort konnte nicht gespeichert werden.');
      }
    });
  };

  const handle5050 = () => {
    if (jokers.used5050 || locked) return;
    if (!socketRef.current) return setActionError('Socket-Verbindung ist nicht verfügbar.');

    socketRef.current.emit('geo:joker:5050', {
      roomCode,
    }, (response) => {
      if (!response.success) setActionError(`50:50-Joker fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
    });
  };

  const handleSpy = () => {
    if (jokers.usedSpy) return;
    if (!socketRef.current) return setActionError('Socket-Verbindung ist nicht verfügbar.');

    socketRef.current.emit('geo:joker:spy', {
      roomCode,
    }, (response) => {
      if (!response.success) setActionError(`Spy-Joker fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
    });
  };

  const handleRisk = () => {
    if (jokers.usedRisk || locked) return;
    if (!socketRef.current) return setActionError('Socket-Verbindung ist nicht verfügbar.');

    socketRef.current.emit('geo:joker:risk', {
      roomCode,
    }, (response) => {
      if (!response.success) setActionError(`Risk-Joker fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
    });
  };

  if (!question) {
    return (
      <div className={styles.page}>
        <div className={styles.waiting}>
          <h1>Warte auf nächste Frage...</h1>
          <Badge variant={connected ? 'success' : 'danger'}>
            {connected ? 'Verbunden' : 'Getrennt'}
          </Badge>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <span className={styles.score}>Score: {score}</span>
        <Badge variant={connected ? 'success' : 'danger'}>
          {connected ? 'Verbunden' : 'Getrennt'}
        </Badge>
      </div>

      {actionError && <p role="alert">{actionError}</p>}
      {answerSubmitted && <p role="status">Antwort gespeichert.</p>}

      <Card padding="lg" className={styles.questionCard}>
        <p className={styles.category}>{question.category}</p>
        <h2 className={styles.prompt}>{question.prompt}</h2>
        
        <div className={styles.timer}>
          {!revealed && <Timer endsAt={endsAt} size="lg" />}
        </div>

        <div className={styles.options}>
          {question.options
            .filter((opt: any) => !eliminatedOptions.includes(opt.id))
            .map((option: any, index: number) => {
              const isSelected = selectedOption === option.id;
              const isCorrect = revealed && option.id === result?.correctOptionId;
              const isWrong = revealed && isSelected && !isCorrect;
              
              return (
                <button
                  key={option.id}
                  className={`${styles.option} ${isSelected ? styles.selected : ''} ${isCorrect ? styles.correct : ''} ${isWrong ? styles.wrong : ''}`}
                  onClick={() => handleSelectOption(option.id)}
                  disabled={locked || revealed}
                >
                  <span className={styles.optionLetter}>
                    {['A', 'B', 'C', 'D'][index]}
                  </span>
                  <span className={styles.optionText}>{option.text}</span>
                </button>
              );
            })}
        </div>

        {revealed && result?.explanation && (
          <p className={styles.explanation}>{result.explanation}</p>
        )}
      </Card>

      <Card padding="md" className={styles.jokerCard}>
        <h3>Joker</h3>
        <div className={styles.jokers}>
          <Button 
            variant={jokers.used5050 ? 'ghost' : 'secondary'}
            disabled={jokers.used5050 || locked}
            onClick={handle5050}
          >
            50:50 {jokers.used5050 && '✓'}
          </Button>
          <Button 
            variant={jokers.usedSpy ? 'ghost' : 'secondary'}
            disabled={jokers.usedSpy}
            onClick={handleSpy}
          >
            Spy {jokers.usedSpy && '✓'}
          </Button>
          <Button 
            variant={jokers.usedRisk ? 'ghost' : 'secondary'}
            disabled={jokers.usedRisk || locked}
            onClick={handleRisk}
          >
            Risk ×2 {jokers.usedRisk && '✓'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
