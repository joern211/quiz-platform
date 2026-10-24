import { expect, it } from 'vitest';
import { coreActionDenial, availableCoreActions, type CoreActionContext } from './actions.js';
import { createTimer } from './runtimePrimitives.js';

function geo(extra: Partial<CoreActionContext> = {}): CoreActionContext {
  return { gameSlug: 'wissensduell', roomStatus: 'RUNNING', informationRole: 'PLAYER', participantId: 'a', active: true, permissions: new Set(['BUZZER_CONTROL']), now: 100,
    state: { phase: 'INPUT_OPEN', currentRoundIndex: 0, questions: [{}], roundStates: { 0: { revealed: false, timer: createTimer('COUNTDOWN', 0, 1000), playerStates: { a: { answered: false, locked: false, jokers: { used5050: false, usedSpy: false, usedRisk: false } }, b: { answered: false, locked: false, jokers: { used5050: false, usedSpy: false, usedRisk: false } } } } } }, ...extra };
}
it('uses the same predicate for deadline, admission and role-specific available actions', () => {
  expect(availableCoreActions(geo()).map(a => a.key)).toEqual(['answer', 'joker5050', 'jokerRisk']);
  expect(coreActionDenial(geo({ now: 1000 }), 'answer')).toBe('TIME_EXPIRED');
  expect(availableCoreActions(geo({ now: 1000 }))).toEqual([]);
  expect(coreActionDenial(geo({ active: false }), 'answer')).toBe('FORBIDDEN');
  expect(availableCoreActions(geo({ informationRole: 'DISPLAY' }))).toEqual([]);
});
it('does not reveal Spy early or let a stored answer be replaced with a fresh command', () => {
  const context = geo(), state = context.state as { roundStates: { 0: { playerStates: { a: { answered: boolean }; b: { answered: boolean } } } } };
  expect(coreActionDenial(context, 'jokerSpy')).toBe('NOT_ALL_ANSWERED');
  state.roundStates[0].playerStates.b.answered = true;
  expect(coreActionDenial(context, 'jokerSpy')).toBeNull();
  state.roundStates[0].playerStates.a.answered = true;
  expect(coreActionDenial(context, 'answer')).toBe('ALREADY_ANSWERED');
});
it('keeps control permissions separate from information roles and rejects invalid state', () => {
  const controller = geo({ informationRole: 'VIEWER', permissions: new Set(['REVEAL_CONTENT']) });
  expect(availableCoreActions(controller).map(a => a.key)).toEqual(['reveal']);
  expect(coreActionDenial(controller, 'answer')).toBe('FORBIDDEN');
  expect(coreActionDenial(geo({ state: { phase: 'INPUT_OPEN' } }), 'answer')).toBe('INVALID_GAME_STATE');
  expect(coreActionDenial(geo({ roomStatus: 'ENDED' }), 'answer')).toBe('GAME_NOT_RUNNING');
});
