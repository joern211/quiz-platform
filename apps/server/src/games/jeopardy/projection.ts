import { roomContentMediaUrl } from '../../content/media.js';
import type { GameRole } from '../core/access.js';
import { visibleValue } from '../core/visibility.js';
import { rankScores } from '../core/roundFlow.js';
import { JeopardySetupSchema } from '../core/setupSchemas.js';
import { fieldKey, type JeopardyGameState } from './state.js';
import { answerAttemptId } from '../core/answerAttempt.js';

/** Explicit allowlist: saved submissions, future answers and pause snapshots never leave the server. */
export function projectJeopardyForClient(state: JeopardyGameState, setupInput: unknown, role: GameRole,
  participants: ReadonlyArray<{ id: string; displayName: string }>, roomId?: string, blindHost = false) {
  const setup = JeopardySetupSchema.partial().parse(setupInput);
  const scores = Object.entries(state.scores).map(([playerId, score]) => ({ playerId,
    playerName: participants.find(p => p.id === playerId)?.displayName ?? state.playerNames[playerId] ?? playerId, score }));
  const fd = state.currentField?.fieldDef;
  const board = state.currentBoard === 1 ? setup.board1 : setup.board2;
  const clue = fd ? board?.categories[fd.categoryIndex]?.clues.find(c => c.value === fd.value) : undefined;
  const resolved = ['FIELD_DONE', 'BOARD_COMPLETE', 'GAME_END'].includes(state.phase) || String(state.phase) !== 'ERROR_RECOVERY' && !!fd && state.lastResolvedFieldKey === `${state.currentBoard}-${fd.categoryIndex}-${fd.value}`;
  const secret = visibleValue({ role, blindHost: blindHost && !resolved }, { scope: 'HOST_PRIVATE' }, () => clue?.answer ?? fd?.answer);
  const currentField = fd ? {
    categoryIndex: fd.categoryIndex, value: fd.value, question: fd.question,
    mediaType: clue?.mediaType, mediaAssetId: clue?.mediaAssetId,
    mediaUrl: roomId ? roomContentMediaUrl(roomId, state.contentRunIndex, typeof clue?.contentId === 'string' ? clue.contentId : undefined, clue?.mediaAssetId) : undefined,
    attemptId: state.phase === 'BUZZ_LOCKED' ? answerAttemptId(`first:${fieldKey(state.currentBoard, fd.categoryIndex, fd.value)}`, state.buzzer, state.buzzWinner)
      : state.phase === 'STEAL_LOCKED' ? answerAttemptId(`steal:${fieldKey(state.currentBoard, fd.categoryIndex, fd.value)}`, state.stealBuzzer, state.stealWinner) : null,
    buzzWinnerId: state.buzzWinner, buzzWinnerName: state.buzzWinner ? state.playerNames[state.buzzWinner] : null,
    firstResponderId: state.currentField?.firstResponderId, phase: state.phase,
    ...(secret !== undefined ? { answer: secret } : {}),
  } : null;
  const playedFields: string[] = [];
  for (const boardNumber of [1, 2] as const) {
    const selected = boardNumber === 1 ? setup.board1 : state.boardCount === 1 ? undefined : setup.board2;
    selected?.categories.forEach((category, index) => category.clues.forEach(clue => {
      const key = `${boardNumber}-${index}-${clue.value}`;
      if (!state.openFields[key]) playedFields.push(key);
    }));
  }
  const categories = (selected: typeof setup.board1) => (selected?.categories ?? []).map(category => ({ name: category.name, clueCount: category.clues.length }));
  return { success: true, role, currentBoard: state.currentBoard, phase: state.phase, scores, currentField, playedFields,
    board1Categories: categories(setup.board1), board2Categories: state.boardCount === 1 ? [] : categories(setup.board2),
    board1Values: (setup.board1?.categories[0]?.clues.map(c => c.value) ?? []).sort((a, b) => a - b),
    board2Values: state.boardCount === 1 ? [] : (setup.board2?.categories[0]?.clues.map(c => c.value) ?? []).sort((a, b) => a - b),
    gameEnded: state.phase === 'GAME_END', buzzWinnerId: state.buzzWinner, stealWinnerId: state.stealWinner,
    playerNames: state.playerNames, stealExcludedPlayerIds: state.stealBuzzer?.excludedPlayerIds ?? (state.currentField?.firstResponderId ? [state.currentField.firstResponderId] : []), finalScores: state.phase === 'GAME_END' ? rankScores(scores) : undefined };
}
