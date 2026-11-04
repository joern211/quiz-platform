import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { biddingActionBindingKey } from '@quiz/shared/bidding';
import { afterEach, expect, it, vi } from 'vitest';
import { BiddingPanel } from '../components/BiddingPanel';
import { expectedFor, SCOPE, standing } from './biddingTestFixtures';

afterEach(cleanup);
const projection = standing({ sv: 5, bv: 3, qv: 2, turn: 3 });
const expected = expectedFor('b1');
const bindingKey = biddingActionBindingKey({ scope: SCOPE, teamId: 'T1', turnNumber: 3, sequenceVersion: 2, biddingVersion: 3 });

it('one rejection permits exactly one retry even when two clicks occur in the same task', () => {
  const onPass = vi.fn();
  const props = { expected, projection, onPass };
  const view = render(<BiddingPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Passen' }));
  expect(onPass).toHaveBeenCalledTimes(1);
  view.rerender(<BiddingPanel {...props} feedback={{ bindingKey, status: 'REJECTED', id: 1 }} />);
  const button = screen.getByRole('button', { name: 'Passen' });
  act(() => { button.click(); button.click(); });
  expect(onPass).toHaveBeenCalledTimes(2);
});

it('a rejected onBid promise releases the numeric input for another bid without external feedback', async () => {
  let reject!: (error: Error) => void;
  const response = new Promise<void>((_, fail) => { reject = fail; });
  const onBid = vi.fn(() => response);
  render(<BiddingPanel expected={expected} projection={projection} onBid={onBid} />);
  const input = screen.getByRole('textbox', { name: 'Dein Gebot' });
  fireEvent.change(input, { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Bieten' }));
  expect(onBid).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('refused')); await response.catch(() => undefined); });
  expect(input).not.toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: /^(Bieten|Erneut senden)$/ })).toBeEnabled(); // N1: after a failed attempt the same button reads "Erneut senden"
});

it('two distinct rejection reports with identical text release their respective numeric input attempts', () => {
  const onBid = vi.fn();
  const props = { expected, projection, onBid };
  const view = render(<BiddingPanel {...props} />);
  const input = screen.getByRole('textbox', { name: 'Dein Gebot' });
  fireEvent.change(input, { target: { value: '7' } });
  const bid = () => fireEvent.click(screen.getByRole('button', { name: /^(Bieten|Erneut senden)$/ }));
  const feedback = { bindingKey, status: 'REJECTED' as const, message: 'Abgelehnt' };
  bid();
  view.rerender(<BiddingPanel {...props} feedback={{ ...feedback, id: 1 }} />);
  bid();
  expect(onBid).toHaveBeenCalledTimes(2);
  view.rerender(<BiddingPanel {...props} feedback={{ ...feedback, id: 2 }} />);
  expect(input).not.toHaveAttribute('readonly');
});

it('a late rejection from a prior attempt cannot unlock an in-flight retry on the same binding', async () => {
  let reject!: (error: Error) => void;
  const first = new Promise<void>((_, fail) => { reject = fail; });
  const onPass = vi.fn().mockReturnValueOnce(first);
  const props = { expected, projection, onPass };
  const view = render(<BiddingPanel {...props} />);
  const pass = () => fireEvent.click(screen.getByRole('button', { name: /^(Passen|Gesendet)$/ }));
  pass();
  view.rerender(<BiddingPanel {...props} feedback={{ bindingKey, status: 'REJECTED', id: 1 }} />);
  pass();
  expect(onPass).toHaveBeenCalledTimes(2);
  await act(async () => { reject(new Error('late refusal of the first attempt')); await first.catch(() => undefined); });
  pass();
  expect(onPass).toHaveBeenCalledTimes(2);
});
