import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createStateEvent } from '@quiz/game-sdk';
import { getGameHandler } from '../registry.js';
import { getGameEngineContract } from './engineContract.js';
import type { EngineResultContext } from './resultBuilders.js';
import { createWerIstDasState } from '../weristdas/state.js';
import { coreActionDenial, type CoreActionContext } from './actionRules.js';

it('uses canonical manifests and validates the actual setup shape for every registered engine', () => {
  for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) {
    const contract = getGameEngineContract(slug)!;
    expect(getGameHandler(slug)?.contract).toBe(contract);
    expect(contract.manifest.slug).toBe(slug);
    expect(contract.recovery.supportedEngineVersions).toContain(contract.manifest.engineVersion);
  }
  expect(getGameEngineContract('geo')).toBe(getGameEngineContract('wissensduell'));
  expect(getGameEngineContract('planned-unknown')).toBeNull();
  expect(getGameEngineContract('wissensduell')!.validateSetup({ selectedQuestionIds: ['a', 'a'] })).toMatchObject({ success: false });
  expect(getGameEngineContract('jeopardy')!.validateSetup({ board1: { categories: [{ name: 'X', clues: [{ value: 100, question: 'Q', answer: 'A' }] }] } })).toEqual({ success: true });
  expect(getGameEngineContract('jeopardy')!.validateSetup({ board1: { categories: [] } })).toMatchObject({ success: false });
});
it('keeps engine/version/run boundaries in deterministic replay and result builders, including legacy versions', () => {
  const contract = getGameEngineContract('wer-ist-das')!;
  const state = createWerIstDasState(1, { a: 'A' });
  const snapshot = { roomId: 'room', runIndex: 1, gameSlug: 'wer-ist-das', engineVersion: 1, stateVersion: 0, state: {} };
  const event = createStateEvent(snapshot, state, { eventId: randomUUID(), type: 'INIT', commandId: null, actorId: null, occurredAtMs: 100 });
  expect(contract.applyEvent(snapshot, event).state).toEqual(state);
  expect(() => getGameEngineContract('jeopardy')!.applyEvent(snapshot, event)).toThrow('WRONG_GAME');
  const result: EngineResultContext = { roomId: 'room', runIndex: 1, gameSlug: 'wer-ist-das', engineVersion: 1, roundIndex: 0, roundCount: 1,
    participants: [{ id: 'a', displayName: 'A', teamId: null }, { id: 'b', displayName: 'B', teamId: null }], scores: { a: 10, b: 5 },
    scoreEvents: [{ participationId: 'a', delta: -1, roundIndex: 0 }, { participationId: 'b', delta: 3, roundIndex: 0 }], contentRefs: ['round-1'], durationMs: null,
    gameEndReason: 'COMPLETED', roundEndReason: 'ANSWER_CORRECT' };
  expect(contract.buildRoundResult(result)).toMatchObject({ winnerIds: ['b'], engineVersion: 1, durationMs: null });
  expect(contract.buildGameResult(result)).toMatchObject({ winnerIds: ['a'], engineVersion: 1 });
  expect(contract.buildGameResult({ ...result, gameEndReason: 'HOST_ABORTED' })).toMatchObject({ aborted: true, winnerIds: [] });
  expect(() => contract.buildGameResult({ ...result, engineVersion: 99 })).toThrow('UNSUPPORTED_ENGINE_VERSION');
});
it('does not turn a normal player buzzer permission into administrative buzzer control', () => {
  const context: CoreActionContext = { gameSlug: 'wer-ist-das', roomStatus: 'RUNNING', state: createWerIstDasState(1, { alice: 'Alice' }),
    informationRole: 'PLAYER', participantId: 'alice', active: true, permissions: new Set(['BUZZER_CONTROL']), now: 100 };
  expect(coreActionDenial(context, 'open')).toBe('FORBIDDEN');
  expect(coreActionDenial({ ...context, buzzerController: true }, 'open')).toBeNull();
  expect(getGameEngineContract('wer-ist-das')!.validateCommand({ ...context, buzzerController: true }, { action: 'open', payload: [] })).toMatchObject({ success: false, error: 'INVALID_PAYLOAD' });
});
