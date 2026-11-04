import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BiddingPanel } from '../components/BiddingPanel';
import { expectedFor, standing } from './biddingTestFixtures';

afterEach(cleanup);

it('a form submission blocked by a same-task pass cannot leave the field waiting after that pass is rejected', async () => {
  let reject!: (error: Error) => void;
  const response = new Promise<void>((_, fail) => { reject = fail; });
  const onBid = vi.fn();
  const onPass = vi.fn(() => response);
  render(<BiddingPanel expected={expectedFor('b1')} projection={standing({ sv: 5, bv: 3, qv: 2, turn: 3 })} onBid={onBid} onPass={onPass} />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Dein Gebot' });
  fireEvent.change(input, { target: { value: '7' } });
  const pass = screen.getByRole<HTMLButtonElement>('button', { name: 'Passen' });
  const bid = screen.getByRole<HTMLButtonElement>('button', { name: 'Bieten' });
  act(() => { pass.click(); bid.click(); });
  expect(onPass).toHaveBeenCalledTimes(1);
  expect(onBid).toHaveBeenCalledTimes(0);
  await act(async () => { reject(new Error('pass refused')); await response.catch(() => undefined); });
  expect(screen.getByRole('button', { name: 'Passen' })).not.toHaveAttribute('aria-disabled');
  expect(input).not.toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: /^(Bieten|Erneut senden)$/ })).toBeEnabled();
});
