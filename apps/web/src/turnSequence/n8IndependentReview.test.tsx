import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TURN_SEQUENCE_CONTRACT, type TurnSequenceProjection } from '@quiz/shared/turnSequence';
import { TurnStatusCard } from '../components/TurnStatusCard';
import { intakeTurnSequence } from './turnIntake';

afterEach(cleanup);
const scope = { runIndex: 1, sequenceId: 'seq-review', rosterRevision: 'roster-review', unit: 'PLAYER' as const };
const aliceProjection: TurnSequenceProjection = {
  contract: TURN_SEQUENCE_CONTRACT, scope, recipientId: 'alice' /* added when the contract gained the recipient binding (N8-01): the packet is Alice's */, stateVersion: 5, sequenceVersion: 1, turnNumber: 1, entitlementRevision: 1,
  release: 'CURRENT', status: 'ACTIVE', current: { teamId: null, playerId: 'alice' },
  you: { holdsTurn: true, teamHoldsTurn: null, canAct: true },
};

it('a projection made for Alice cannot tell Bob that he may act', () => {
  const expected = { ...scope, recipientId: 'bob', minStateVersion: 1 };
  const r = intakeTurnSequence(null, expected, aliceProjection);
  expect(r.held?.release !== 'NONE' && r.held?.you?.canAct).not.toBe(true);
});

it('switching recipient from Alice to Bob before a fresh recipient projection arrives does not offer Alice\'s action to Bob', () => {
  const onAdvance = vi.fn();
  const view = render(<TurnStatusCard expected={{ ...scope, recipientId: 'alice', minStateVersion: 1 }} projection={aliceProjection} onAdvance={onAdvance} />);
  expect(screen.getByRole('button', { name: 'Zug beenden' })).toBeInTheDocument();
  view.rerender(<TurnStatusCard expected={{ ...scope, recipientId: 'bob', minStateVersion: 1 }} projection={aliceProjection} onAdvance={onAdvance} />);
  expect(screen.queryByRole('button', { name: 'Zug beenden' })).not.toBeInTheDocument();
  expect(screen.queryByText('Du bist am Zug.')).not.toBeInTheDocument();
});
