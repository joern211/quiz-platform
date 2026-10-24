// ============================================================
// Jeopardy Game Hook — Socket interface for all client roles
// Phase 5: Unified hook for moderator, player, spectator
// ============================================================

import { useEffect, useRef, useState, useCallback } from 'react';
import { getSocket, connectSocket, disconnectSocket, getSessionData, emitCommand, type PlayerRole, type JeopardyResyncResponse } from '../lib/socket';

// ── Event payload types ────────────────────────────────────────

export interface JeopardyInitPayload {
  boardNumber: 1 | 2;
  categories: Array<{ name: string; clueCount: number }>;
  values: number[];
  scores: Record<string, number>;
  playerNames?: Record<string, string>;
}

export interface JeopardyFieldOpenPayload {
  categoryIndex: number;
  value: number;
  question: string;
  mediaType?: string;
  mediaAssetId?: string;
}

export interface JeopardyBuzzWonPayload {
  playerId: string;
  playerName: string;
}

export interface JeopardyRevealPayload {
  answer: string; // Only for HOST; masked for PLAYER/VIEWER
  correct: boolean;
  playerId: string;
  playerName: string;
  fieldValue: number;
  delta: number;
  scores: Record<string, number>;
}

export interface JeopardyStealOpenPayload {
  categoryIndex: number;
  value: number;
  scores?: Record<string, number>;
  excludedPlayerId?: string;
  excludedPlayerIds?: string[];
}

export interface JeopardyStealClosePayload {
  answer: string;
  thiefCorrect: boolean;
  thiefDelta: number;
  scores: Record<string, number>;
}

export interface JeopardyFieldDonePayload {
  categoryIndex: number;
  value: number;
}

export interface JeopardyBoardSwitchPayload {
  fromBoard: 1 | 2;
  toBoard: 2 | 1;
  categories: Array<{ name: string; clueCount: number }>;
  values: number[];
  scores: Record<string, number>;
}

export interface JeopardyGameEndPayload {
  finalScores: Array<{ playerId: string; playerName: string; score: number }>;
  winnerIds: string[];
}

// ── Hook state ─────────────────────────────────────────────────

export type JeopardyPhase =
  | 'PAUSED'
  | 'INTRO'
  | 'SELECTING'
  | 'BUZZ_OPEN'
  | 'BUZZ_LOCKED'
  | 'STEAL_OPEN'
  | 'STEAL_LOCKED'
  | 'FIELD_DONE'
  | 'BOARD_COMPLETE'
  | 'GAME_END';

export interface JeopardyGameState {
  boardNumber: 1 | 2;
  categories: Array<{ name: string; clueCount: number }>;
  values: number[];
  scores: Record<string, number>;
  playerNames: Record<string, string>;
  phase: JeopardyPhase;
  currentField: {
    categoryIndex: number;
    value: number;
    question: string;
  } | null;
  buzzWinner: JeopardyBuzzWonPayload | null;
  reveal: JeopardyRevealPayload | null;
  stealWinner: JeopardyBuzzWonPayload | null;
  stealExcludedId: string | null;
  stealExcludedIds: string[];
  stealResult: JeopardyStealClosePayload | null;
  playedFields: string[]; // "categoryIndex-value" keys
  gameEnd: JeopardyGameEndPayload | null;
}

// ── Hook ───────────────────────────────────────────────────────

export function useJeopardy(roomCode: string, role: PlayerRole) {
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);
  const rejoinToken = getSessionData().rejoinToken;

  const [connected, setConnected] = useState(false);
  const [gameState, setGameState] = useState<JeopardyGameState>({
    boardNumber: 1,
    categories: [],
    values: [],
    scores: {},
    playerNames: {},
    phase: 'INTRO',
    currentField: null,
    buzzWinner: null,
    reveal: null,
    stealWinner: null,
    stealExcludedId: null,
    stealExcludedIds: [],
    stealResult: null,
    playedFields: [],
    gameEnd: null,
  });

  // BASIS-STANDARDS: Intent-Kontext (aktuelles Feld) per Ref, damit die
  // Action-Callbacks ohne Re-Render auf den aktuellen Stand zugreifen.
  const gameStateRef = useRef<JeopardyGameState>(gameState);
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
  const fieldKey = () => {
    const ref = gameStateRef.current;
    const cf = ref.currentField;
    return cf ? `b${ref.boardNumber}-f${cf.categoryIndex}-${cf.value}` : 'none';
  };
  const [secretAnswer, setSecretAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Connect and subscribe ───────────────────────────────────

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    const refresh = () => {
          socket.emit('jeopardy:resync', {}, (res: JeopardyResyncResponse) => {
            if (!res.success || !res.currentBoard || !res.phase) {
              setError(`Spielstand konnte nicht geladen werden: ${res.error ?? 'Ungültige Antwort'}`);
              return;
            }
            const scores = Object.fromEntries((res.scores ?? []).map((entry) => [entry.playerId, entry.score]));
            const playerNames = res.playerNames ?? Object.fromEntries((res.scores ?? []).map((entry) => [entry.playerId, entry.playerName]));
            setSecretAnswer(role === 'HOST' ? res.currentField?.answer ?? null : null);
            setGameState((prev) => ({
              ...prev,
              boardNumber: res.currentBoard!,
              categories: res.currentBoard === 1 ? res.board1Categories ?? [] : res.board2Categories ?? [],
              values: res.currentBoard === 1 ? res.board1Values ?? [] : res.board2Values ?? [],
              scores,
              playerNames,
              phase: res.phase!,
              currentField: res.currentField ? { categoryIndex: res.currentField.categoryIndex, value: res.currentField.value, question: res.currentField.question } : null,
              buzzWinner: res.buzzWinnerId ? { playerId: res.buzzWinnerId, playerName: playerNames[res.buzzWinnerId] ?? '' } : null,
              stealWinner: res.stealWinnerId ? { playerId: res.stealWinnerId, playerName: playerNames[res.stealWinnerId] ?? '' } : null,
              stealExcludedId: res.currentField?.firstResponderId ?? null,
              stealExcludedIds: res.stealExcludedPlayerIds ?? (res.currentField?.firstResponderId ? [res.currentField.firstResponderId] : []),
              playedFields: (res.playedFields ?? []).filter((key) => key.startsWith(`${res.currentBoard}-`)).map((key) => key.slice(2)),
              gameEnd: res.phase === 'GAME_END' && res.finalScores ? { finalScores: res.finalScores, winnerIds: res.finalScores.filter((entry) => entry.score === res.finalScores![0]?.score).map((entry) => entry.playerId) } : null,
            }));
          });
    };

    const subscribe = () => {
      setConnected(true);
      socket.emit(
        'room:subscribe',
        { roomCode, role, rejoinToken: rejoinToken ?? undefined },
        (response) => {
          if (!response.success) {
            setError(`Raumverbindung fehlgeschlagen: ${response.error}`);
            return;
          }
          refresh();
        }
      );
    };

    socket.on('game:core:changed', refresh);
    socket.on('game:pause', refresh);
    socket.on('game:resume', refresh);
    socket.on('connect', subscribe);
    if (socket.connected) subscribe();
    connectSocket();

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('game:start', (data) => {
      if (data.status === 'RUNNING') {
        // Jeopardy game is starting
      }
    });

    socket.on('jeopardy:board:complete', () => {
      setGameState((prev) => ({ ...prev, phase: 'BOARD_COMPLETE' }));
    });

    // ── Jeopardy events ──────────────────────────────────────

    socket.on('jeopardy:init', (data: JeopardyInitPayload) => {
      setGameState((prev) => ({
        ...prev,
        boardNumber: data.boardNumber,
        categories: data.categories,
        values: data.values,
        scores: data.scores,
        playerNames: data.playerNames ?? {},
        phase: 'SELECTING',
        currentField: null,
        buzzWinner: null,
        reveal: null,
        stealWinner: null,
        stealExcludedId: null,
        stealExcludedIds: [],
        stealResult: null,
        playedFields: [],
      }));
    });

    socket.on('jeopardy:field:open', (data: JeopardyFieldOpenPayload) => {
      setSecretAnswer(null);
      setGameState((prev) => ({
        ...prev,
        phase: 'BUZZ_OPEN',
        currentField: {
          categoryIndex: data.categoryIndex,
          value: data.value,
          question: data.question,
        },
        buzzWinner: null,
        reveal: null,
        stealWinner: null,
        stealExcludedId: null,
        stealExcludedIds: [],
        stealResult: null,
      }));
    });

    // Secret answer — HOST only
    socket.on('jeopardy:answer:secret', (data: { answer: string }) => {
      setSecretAnswer(data.answer);
    });

    socket.on('jeopardy:buzz:won', (data: { playerId: string; playerName: string }) => {
      setGameState((prev) => ({
        ...prev,
        phase: 'BUZZ_LOCKED',
        buzzWinner: { playerId: data.playerId, playerName: data.playerName },
      }));
    });

    socket.on('jeopardy:reveal', (data: JeopardyRevealPayload) => {
      setGameState((prev) => ({
        ...prev,
        phase: 'FIELD_DONE',
        reveal: data,
        scores: data.scores,
        buzzWinner: null,
      }));
    });

    socket.on('jeopardy:steal:open', (data: JeopardyStealOpenPayload) => {
      setGameState((prev) => ({
        ...prev,
        phase: 'STEAL_OPEN',
        scores: data.scores ?? prev.scores,
        stealWinner: null,
        stealExcludedId: data.excludedPlayerId ?? null,
        stealExcludedIds: data.excludedPlayerIds ?? (data.excludedPlayerId ? [data.excludedPlayerId] : []),
        reveal: null,
      }));
    });

    socket.on('jeopardy:steal:buzz:won', (data: { playerId: string; playerName: string }) => {
      setGameState((prev) => ({
        ...prev,
        phase: 'STEAL_LOCKED',
        stealWinner: { playerId: data.playerId, playerName: data.playerName },
      }));
    });

    socket.on('jeopardy:steal:close', (data: JeopardyStealClosePayload) => {
      setGameState((prev) => ({
        ...prev,
        phase: 'FIELD_DONE',
        stealResult: data,
        scores: data.scores,
        stealWinner: null,
        stealExcludedId: null,
        stealExcludedIds: [],
        buzzWinner: null,
      }));
    });

    socket.on('jeopardy:field:done', (data: JeopardyFieldDonePayload) => {
      const key = `${data.categoryIndex}-${data.value}`;
      setGameState((prev) => {
        if (prev.playedFields.includes(key)) return prev;
        return {
          ...prev,
          playedFields: [...prev.playedFields, key],
        };
      });
    });

    socket.on('jeopardy:next', () => {
      setGameState((prev) => ({
        ...prev,
        phase: 'SELECTING',
        currentField: null,
        reveal: null,
        stealResult: null,
      }));
    });

    socket.on('jeopardy:board:switch', (data: JeopardyBoardSwitchPayload) => {
      setSecretAnswer(null);
      setGameState((prev) => ({
        ...prev,
        boardNumber: data.toBoard,
        categories: data.categories,
        values: data.values,
        scores: data.scores,
        phase: 'SELECTING',
        currentField: null,
        buzzWinner: null,
        reveal: null,
        stealWinner: null,
        stealResult: null,
        playedFields: [],
      }));
    });

    socket.on('jeopardy:game:end', (data: JeopardyGameEndPayload) => {
      setSecretAnswer(null);
      setGameState((prev) => ({
        ...prev,
        phase: 'GAME_END',
        gameEnd: data,
        scores: Object.fromEntries(
          data.finalScores.map((s) => [s.playerId, s.score])
        ),
      }));
    });

    return () => {
      socket.off('game:core:changed', refresh);
      socket.off('game:pause', refresh);
      socket.off('game:resume', refresh);
      disconnectSocket();
    };
  }, [roomCode, role, rejoinToken]);

  // ── Actions ─────────────────────────────────────────────────

  const openField = useCallback(
    (boardIndex: 1 | 2, categoryIndex: number, value: number) => {
      if (!socketRef.current) return;
      emitCommand(
        socketRef.current,
        'jeopardy:field:open',
        { boardIndex, categoryIndex, value },
        `${roomCode}:jp:open:${boardIndex}-${categoryIndex}-${value}`,
        (res: { success: boolean; error?: string }) => {
          if (!res.success) setError(`Feld öffnen fehlgeschlagen: ${res.error}`);
        }
      );
    },
    [roomCode]
  );

  const buzz = useCallback(() => {
    if (!socketRef.current) return;
    // Audit PR14, 14-01: Token-Lebenszyklus über emitCommand — ein Buzzer-
    // Retry (Doppelklick/ACK-Verlust) sendet denselben Token; die nächste
    // zulässige Absicht erhält ein frisches Token.
    emitCommand(socketRef.current, 'jeopardy:buzz', {}, `${roomCode}:jp:buzz:${fieldKey()}`, (res: { success: boolean; error?: string }) => {
      if (!res.success && res.error !== 'BUZZER_ALREADY_WON') {
        setError(`Buzzer fehlgeschlagen: ${res.error}`);
      }
    });
  }, [roomCode]);

  const judge = useCallback(
    (correct: boolean) => {
      if (!socketRef.current) return;
      // Andere Bewertung (correct/!correct) = andere Absicht → eigener Key.
      emitCommand(
        socketRef.current,
        'jeopardy:judge',
        { correct },
        `${roomCode}:jp:judge:${fieldKey()}:${correct}`,
        (res: { success: boolean; error?: string }) => {
          if (!res.success) setError(`Urteil fehlgeschlagen: ${res.error}`);
        }
      );
    },
    [roomCode]
  );

  const stealBuzz = useCallback(() => {
    if (!socketRef.current) return;
    emitCommand(
      socketRef.current,
      'jeopardy:steal:buzz',
      {},
      `${roomCode}:jp:stealBuzz:${fieldKey()}`,
      (res: { success: boolean; error?: string }) => {
        if (!res.success && res.error !== 'STEAL_ALREADY_WON') {
          setError(`Abstauber-Buzzer fehlgeschlagen: ${res.error}`);
        }
      }
    );
  }, [roomCode]);

  const stealJudge = useCallback(
    (correct: boolean) => {
      if (!socketRef.current) return;
      emitCommand(
        socketRef.current,
        'jeopardy:steal:judge',
        { correct },
        `${roomCode}:jp:stealJudge:${fieldKey()}:${correct}`,
        (res: { success: boolean; error?: string }) => {
          if (!res.success) setError(`Abstauber-Urteil fehlgeschlagen: ${res.error}`);
        }
      );
    },
    [roomCode]
  );

  const next = useCallback(() => {
    if (!socketRef.current) return;
    emitCommand(socketRef.current, 'jeopardy:next', {}, `${roomCode}:jp:next:${fieldKey()}`, (res: { success: boolean; error?: string }) => {
      if (!res.success) setError(`Weiter fehlgeschlagen: ${res.error}`);
    });
  }, [roomCode]);

  const switchBoard = useCallback(
    (toBoard: 2 | 1) => {
      if (!socketRef.current) return;
      emitCommand(
        socketRef.current,
        'jeopardy:board:switch',
        { toBoard },
        `${roomCode}:jp:board:${toBoard}`,
        (res: { success: boolean; error?: string }) => {
          if (!res.success) setError(`Board-Wechsel fehlgeschlagen: ${res.error}`);
        }
      );
    },
    [roomCode]
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    connected,
    gameState,
    secretAnswer,
    error,
    clearError,
    actions: {
      openField,
      buzz,
      judge,
      stealBuzz,
      stealJudge,
      next,
      switchBoard,
    },
  };
}
