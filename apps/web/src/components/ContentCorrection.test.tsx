import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, it, expect, vi } from 'vitest';
import { ContentCorrection } from './ContentCorrection';
import { contentApi } from '../lib/contentApi';
import { setSession } from '../lib/sessionStore';

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
it('loads revealed content only on demand and retries the same correction command after a network failure', async () => {
  setSession({ roomCode: '123-456', participationId: 'player-id', rejoinToken: 'secure-rejoin-token', role: 'PLAYER' });
  const read = vi.spyOn(contentApi, 'correctionContent').mockResolvedValue([{ itemId: 'q1', revision: 2, runIndex: 1,
    payload: { prompt: 'Frage mit Fehler', correctOptionId: 'a', category: 'Test' } }]);
  const submit = vi.spyOn(contentApi, 'submitCorrection').mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ reviewId: 'review' });
  render(<ContentCorrection roomCode="123-456" runIndex={1} />);
  expect(read).not.toHaveBeenCalled();
  await userEvent.click(screen.getByText('Fehler an einer gespielten Frage melden'));
  expect(await screen.findByLabelText('Bisheriger Wert')).toHaveValue('Frage mit Fehler');
  await userEvent.type(screen.getByLabelText('Dein Korrekturvorschlag'), 'Korrigierte Frage');
  await userEvent.click(screen.getByRole('button', { name: 'Korrekturvorschlag senden' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
  expect(screen.getByLabelText('Dein Korrekturvorschlag')).toHaveValue('Korrigierte Frage');
  await userEvent.click(screen.getByRole('button', { name: 'Korrekturvorschlag senden' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0]);
  expect(await screen.findByRole('status')).toHaveTextContent('zur Prüfung gespeichert');
});
