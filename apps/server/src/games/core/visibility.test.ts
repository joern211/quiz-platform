import { expect, it, vi } from 'vitest';
import { canView, visibleValue } from './visibility.js';
import { projectGeoStateForClient } from '../geo/resync.js';
import { projectWerIstDas } from '../weristdas/resync.js';
import { createWerIstDasState } from '../weristdas/state.js';

it('separates administrative information from own/team secrets and never creates denied values', () => {
  const privateAnswer = { scope: 'PLAYER_PRIVATE', ownerParticipantId: 'alice' } as const;
  for (const role of ['HOST', 'VIEWER', 'DISPLAY'] as const) {
    const read = vi.fn(() => 'SECRET');
    expect(visibleValue({ role, participantId: 'alice', teamId: 'red' }, privateAnswer, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(canView({ role, teamId: 'red' }, { scope: 'TEAM_PRIVATE', ownerTeamId: 'red' })).toBe(false);
  }
  expect(canView({ role: 'PLAYER', participantId: 'alice' }, privateAnswer)).toBe(true);
  expect(canView({ role: 'PLAYER', participantId: 'bob' }, privateAnswer)).toBe(false);
  expect(canView({ role: 'PLAYER', teamId: 'red' }, { scope: 'TEAM_PRIVATE', ownerTeamId: 'red' })).toBe(true);
  expect(canView({ role: 'DISPLAY' }, { ...privateAnswer, publiclyRevealed: true })).toBe(true);
});
it('both real projections release only the explicit public solution and own private data', () => {
  const state = { phase: 'INPUT_OPEN', currentRoundIndex: 0, scores: { alice: 0 }, questions: [{ correctOptionId: 'SOLUTION' }], roundStates: {
    0: { question: { id: 'q', prompt: 'Question', category: 'Test', mediaAssetId: 'public-image', options: [{ id: 'a', text: 'A', label: 'A', imageUrl: '/public-option.png' }], injectedSecret: 'DO_NOT_SPREAD' }, timerEndMs: 1000, pauseRemainingMs: null, revealed: false,
      playerStates: { alice: { answered: true, selectedOptionId: 'PRIVATE_ANSWER', jokers: { used5050: false, usedSpy: false, usedRisk: false } } } },
  } };
  const publicGeo = projectGeoStateForClient(state, { role: 'VIEWER', roomId: 'r' });
  expect(JSON.stringify(publicGeo)).not.toMatch(/SOLUTION|PRIVATE_ANSWER|DO_NOT_SPREAD/);
  expect(publicGeo.question).toMatchObject({ mediaAssetId: 'public-image', options: [{ label: 'A', imageUrl: '/public-option.png' }] });
  expect(projectGeoStateForClient(state, { role: 'PLAYER', roomId: 'r', participationId: 'alice' })).toMatchObject({ ownAnswer: 'PRIVATE_ANSWER' });
  state.roundStates[0].revealed = true;
  expect(projectGeoStateForClient(state, { role: 'VIEWER', roomId: 'r' }).question).toHaveProperty('correctOptionId', 'SOLUTION');
  const wid = createWerIstDasState(1, { alice: 'Alice' });
  const setup = { setupSchemaVersion: 1 as const, rounds: [{ id: 'r', imageAssetId: 'public-image', person1: 'SECRET_A', person2: 'SECRET_B', aliases1: [], aliases2: [] }] };
  expect(JSON.stringify(projectWerIstDas(wid, setup, 'VIEWER'))).not.toMatch(/SECRET_A|SECRET_B/);
  expect(projectWerIstDas({ ...wid, revealed: true }, setup, 'VIEWER')).toMatchObject({ person1: 'SECRET_A', person2: 'SECRET_B' });
});
