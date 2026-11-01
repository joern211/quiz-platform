import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VoteForm, type VoteFeedback } from './VoteForm';
import type { VotingOptionsConfig } from '@quiz/shared/voting';

const config: VotingOptionsConfig = {
  schemaVersion: 1, prompt: 'Wähle eine Option',
  options: [{ optionId: 'alpha', label: 'Alpha', help: null }, { optionId: 'beta', label: 'Beta', help: null }],
};

describe('Independent N4 review: acknowledgement without a ballot payload', () => {
  for (const abstain of [false, true]) {
    it(`keeps the accepted ${abstain ? 'abstention' : 'option vote'} confirmed after a later lock without data`, async () => {
      const onSubmit = vi.fn();
      const base = { config, selectableOptionIds: ['alpha', 'beta'], allowAbstain: true, contextKey: 'poll-1', onSubmit };
      const view = render(<VoteForm {...base} />);
      const set = (feedback: VoteFeedback) => view.rerender(<VoteForm {...base} feedback={feedback} />);
      const radio = () => screen.getByRole('radio', { name: abstain ? /^Enthalten/ : /^Alpha/ });
      await userEvent.click(radio());
      await userEvent.click(screen.getByRole('button', { name: 'Stimme abgeben' }));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      // A matching successful ACK is legal without optional ballot data and confirms this exact attempt.
      set({ contextKey: 'poll-1', attemptId: 'poll-1#1', status: 'SUBMITTED' });
      expect(screen.getByRole('status')).toHaveTextContent(abstain ? 'Enthaltung abgegeben.' : 'Stimme abgegeben.');
      expect(radio()).toBeChecked();
      // Closing the poll provides no replacement ballot and cannot revoke the previous acknowledgement.
      set({ contextKey: 'poll-1', attemptId: null, status: 'LOCKED' });
      expect(radio()).toBeChecked();
      expect(screen.getByRole('status')).toHaveTextContent('Die Abstimmung ist geschlossen.');
      expect(screen.getByRole('status')).not.toHaveTextContent('nicht als abgegebene Stimme bestätigt');
      expect(screen.getByRole('button', { name: 'Stimme abgeben' })).toBeDisabled();
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  }
});
