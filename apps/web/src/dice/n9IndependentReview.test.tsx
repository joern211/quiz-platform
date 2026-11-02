import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DICE_CONFIG_FIVE_D6_HOLD, DICE_CONTRACT, type DiceProjection } from '@quiz/shared/dice';
import { DiceTray } from '../components/DiceTray';

afterEach(cleanup);
const scope = { runIndex: 1, sequenceId: 'seq-old', rosterRevision: 'roster', unit: 'PLAYER' as const };

function packet(which: 'old' | 'new', rolled: boolean): DiceProjection {
  return {
    contract: DICE_CONTRACT, scope: { ...scope, sequenceId: `seq-${which}` }, diceId: `dice-${which}`, recipientId: 'a',
    stateVersion: which === 'old' ? 5 : 10, sequenceVersion: 1, turnNumber: 1, diceVersion: rolled ? 1 : 0, rollCount: rolled ? 1 : 0,
    release: 'VALUES', status: rolled ? 'IN_PROGRESS' : 'PREPARED', config: { ...DICE_CONFIG_FIVE_D6_HOLD },
    values: rolled ? [1, 2, 3, 4, 5] : null, held: [false, false, false, false, false], lastRolled: rolled ? [0, 1, 2, 3, 4] : [],
    holder: { playerId: 'a', teamId: null }, you: { holdsTurn: true, teamHoldsTurn: null, canRoll: true, canHold: rolled },
  };
}

it.each(['ROLL', 'HOLD'] as const)('%s intents emitted in two different sequences must remain distinguishable when queued for transport', kind => {
  const first = packet('old', kind === 'HOLD');
  const second = packet('new', kind === 'HOLD');
  const send = vi.fn();
  const props = (p: DiceProjection) => ({ projection: p, expected: { ...p.scope, recipientId: 'a', minStateVersion: 1 }, onRoll: send, onHold: send });
  const view = render(<DiceTray {...props(first)} />);
  const click = () => fireEvent.click(kind === 'ROLL' ? screen.getByRole('button', { name: 'Würfeln' }) : screen.getAllByRole('button', { name: /^Würfel / })[0]);
  click();
  expect(send).toHaveBeenCalledTimes(1);
  view.rerender(<DiceTray {...props(second)} />);
  click();
  expect(send).toHaveBeenCalledTimes(2); // both contexts are current and actionable when clicked
  expect(send.mock.calls[0][0]).not.toEqual(send.mock.calls[1][0]);
});
