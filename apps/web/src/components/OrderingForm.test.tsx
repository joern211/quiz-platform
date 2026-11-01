import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, ACCENTS } from '@quiz/ui';
import type { OrderingConfig, OrderingValue } from '@quiz/shared/ordering';
import { describe, expect, it, vi } from 'vitest';
import { OrderingForm, type OrderingFeedback, type OrderingFormProps } from './OrderingForm';

// Synthetic fixture: ids and labels are NOT game presets and carry no value, date or rank.
const items = [
  { itemId: 'aa', label: 'Alpha', help: 'Erste Hilfe' },
  { itemId: 'bb', label: 'Beta', help: null },
  { itemId: 'cc', label: 'Gamma', help: null },
  { itemId: 'dd', label: 'Delta', help: null },
];
const config: OrderingConfig = { schemaVersion: 1, prompt: 'Bringe die Einträge in deine Reihenfolge.', directionHint: 'Oben steht zuerst.', items };
const CTX = 'run1:round1';
const val = (...ids: string[]): OrderingValue => ({ schemaVersion: 1, itemIds: ids });

function mount(props: Partial<OrderingFormProps> = {}) {
  const onSubmit = vi.fn();
  const base: OrderingFormProps = { title: 'Meine Reihenfolge', config, contextKey: CTX, onSubmit, ...props };
  const view = render(<OrderingForm {...base} />);
  return { onSubmit, view, base, set: (next: Partial<OrderingFormProps>) => view.rerender(<OrderingForm {...base} {...next} />) };
}
const rows = () => screen.getAllByRole('listitem');
const labelsInOrder = () => rows().map(r => (r.querySelector('[class*="label"]') as HTMLElement).textContent);
const up = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label} nach oben`) });
const down = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label} nach unten`) });
const send = () => screen.getByRole('button', { name: /^(Abgeben|Erneut senden)$/ });
const live = () => screen.getByTestId('ordering-live');

describe('N3 OrderingForm: list, moves and accessible names', () => {
  it('shows the public items in the start order given by the caller, with positions, prompt and direction hint', () => {
    mount();
    expect(labelsInOrder()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(screen.getByRole('heading', { name: 'Meine Reihenfolge' })).toBeInTheDocument();
    expect(screen.getByText('Bringe die Einträge in deine Reihenfolge.')).toBeInTheDocument();
    expect(screen.getByText('Oben steht zuerst.')).toBeInTheDocument();
    expect(screen.getByText('Erste Hilfe')).toBeInTheDocument();
    expect(rows().map(r => r.querySelector('[class*="position"]')?.textContent)).toEqual(['1', '2', '3', '4']);
    expect(screen.getByRole('list')).toHaveAccessibleDescription(/Erst mit „Abgeben“ wird die Reihenfolge gesendet/);
  });
  it('every move button is a real type=button with a name that carries the label, direction and position', () => {
    mount();
    expect(up('Beta')).toHaveAttribute('type', 'button');
    expect(up('Beta')).toHaveAccessibleName('Beta nach oben, Position 2 von 4');
    expect(down('Beta')).toHaveAccessibleName('Beta nach unten, Position 2 von 4');
    expect(send()).toHaveAttribute('type', 'submit');
    expect(document.querySelectorAll('form form')).toHaveLength(0);
    for (const b of screen.getAllByRole('button').filter(b => b !== send())) expect(b).toHaveAttribute('type', 'button');
  });
  it('moves an item up and down by click without sending anything', async () => {
    const { onSubmit } = mount();
    await userEvent.click(down('Alpha'));
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    await userEvent.click(up('Delta'));
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Delta', 'Gamma']);
    await userEvent.click(up('Delta'));
    expect(labelsInOrder()).toEqual(['Beta', 'Delta', 'Alpha', 'Gamma']);
    expect(live()).toHaveTextContent('Delta steht jetzt auf Position 2 von 4.');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('has no wrap-around: first "up" and last "down" do nothing, say so, and stay focusable', async () => {
    const { onSubmit } = mount();
    expect(up('Alpha')).toHaveAttribute('aria-disabled', 'true');
    expect(up('Alpha')).not.toBeDisabled();
    expect(down('Delta')).toHaveAttribute('aria-disabled', 'true');
    expect(up('Beta')).not.toHaveAttribute('aria-disabled');
    await userEvent.click(up('Alpha'));
    await userEvent.click(down('Delta'));
    expect(labelsInOrder()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(live()).toHaveTextContent('Delta steht bereits auf Position 4 von 4.');
    expect(down('Delta')).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('keeps duplicate labels distinguishable by position and treats them as different items by id', async () => {
    const dup: OrderingConfig = { ...config, items: [{ itemId: 'aa', label: 'Gleich', help: null }, { itemId: 'bb', label: 'Gleich', help: null }, { itemId: 'cc', label: 'Anders', help: null }] };
    const { onSubmit } = mount({ config: dup });
    const downs = screen.getAllByRole('button', { name: /^Gleich nach unten/ });
    expect(downs.map(b => b.getAttribute('aria-label'))).toEqual(['Gleich nach unten, Position 1 von 3', 'Gleich nach unten, Position 2 von 3']);
    await userEvent.click(downs[0]); // the FIRST "Gleich" (aa) moves down
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(val('bb', 'aa', 'cc'), `${CTX}#1`);
  });
});

describe('N3 OrderingForm: keyboard, focus and submission', () => {
  it('Enter and Space on a move button move exactly once and never submit the form', async () => {
    const { onSubmit } = mount();
    up('Beta').focus();
    await userEvent.keyboard('{Enter}');
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    await userEvent.keyboard(' ');
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']); // already first: no wrap, no second move
    down('Beta').focus();
    await userEvent.keyboard('{Enter}');
    expect(labelsInOrder()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    await userEvent.keyboard(' ');
    expect(labelsInOrder()).toEqual(['Alpha', 'Gamma', 'Beta', 'Delta']);
    expect(onSubmit).not.toHaveBeenCalled();
  });
  // jsdom drops and restores focus on its own when nodes are re-inserted, so this checks the visible contract only; the real
  // browser behaviour (focus restoration after the node moved) is proven in the Chromium harness (harness/n3-ordering/check.cjs).
  it('keeps the focus on the button just used while the item travels (also at the edges), so repeated keys keep working', async () => {
    mount();
    down('Alpha').focus();
    await userEvent.keyboard('{Enter}{Enter}{Enter}');
    expect(labelsInOrder()).toEqual(['Beta', 'Gamma', 'Delta', 'Alpha']);
    expect(down('Alpha')).toHaveFocus(); // now last: the button is still there and focused
    await userEvent.keyboard('{Enter}');
    expect(labelsInOrder()).toEqual(['Beta', 'Gamma', 'Delta', 'Alpha']);
    expect(down('Alpha')).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(up('Alpha')).toHaveFocus(); // natural tab order inside the row
    await userEvent.keyboard('{Enter}');
    expect(labelsInOrder()).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta']);
    expect(up('Alpha')).toHaveFocus();
  });
  it('the explicit submit sends the complete visible order exactly once; the unchanged start order is a valid submission', async () => {
    const a = mount();
    await userEvent.click(send());
    expect(a.onSubmit).toHaveBeenCalledTimes(1);
    expect(a.onSubmit).toHaveBeenCalledWith(val('aa', 'bb', 'cc', 'dd'), `${CTX}#1`);
    a.view.unmount();
    const b = mount();
    await userEvent.click(down('Alpha'));
    await userEvent.click(up('Delta'));
    await userEvent.click(send());
    expect(b.onSubmit).toHaveBeenCalledTimes(1);
    expect(b.onSubmit).toHaveBeenCalledWith(val('bb', 'aa', 'dd', 'cc'), `${CTX}#1`);
  });
  it('hands out a fresh copy: later moves never alias the object that was sent', async () => {
    const { onSubmit, set } = mount();
    await userEvent.click(send());
    const sent = onSubmit.mock.calls[0][0] as OrderingValue;
    const snapshot = JSON.stringify(sent);
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true } });
    await userEvent.click(down('Alpha'));
    expect(JSON.stringify(sent)).toBe(snapshot);
  });
  it('locks at once: Enter, double click and a late PENDING never send a second time, and moves do nothing meanwhile', async () => {
    const { onSubmit, set } = mount();
    await userEvent.dblClick(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(send()).toBeDisabled();
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) { expect(up(name)).toBeDisabled(); expect(down(name)).toBeDisabled(); }
    await userEvent.click(down('Alpha'));
    expect(labelsInOrder()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'PENDING' } }); // late PENDING
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it('moves the focus to the status line when the form freezes, instead of leaving it on a disabled button', async () => {
    mount();
    send().focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('status')).toHaveFocus();
  });
  it('works with a parent that answers synchronously from inside onSubmit', async () => {
    function Parent() {
      const [fb, setFb] = useStateLike();
      return <OrderingForm config={config} contextKey="c" onSubmit={(_o, attemptId) => setFb({ contextKey: 'c', attemptId, status: 'SUBMITTED', order: val('bb', 'aa', 'cc', 'dd') })} feedback={fb} />;
    }
    render(<Parent />);
    await userEvent.click(down('Alpha'));
    await userEvent.click(send());
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
  });
});
import { useState } from 'react';
function useStateLike() { return useState<OrderingFeedback | null>(null); }

describe('N3 OrderingForm: feedback and attempt contract (N1-R1 on the real component)', () => {
  const r1 = 'run1:round1', r2 = 'run1:round2';
  const confirmed = (...ids: string[]) => val(...ids);

  it('R1-A: an old-round ACK does not remove the new round\'s pending state or lock', async () => {
    const { onSubmit, set } = mount();
    await userEvent.click(down('Alpha'));
    await userEvent.click(send());
    set({ contextKey: r2 });
    await userEvent.click(down('Beta'));
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(val('aa', 'cc', 'bb', 'dd'), `${r2}#2`);
    set({ contextKey: r2, feedback: { contextKey: r2, attemptId: `${r2}#2`, status: 'PENDING' } });
    expect(send()).toBeDisabled();
    set({ contextKey: r2, feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', order: confirmed('bb', 'aa', 'cc', 'dd') } });
    expect(labelsInOrder()).toEqual(['Alpha', 'Gamma', 'Beta', 'Delta']);
    expect(send()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
  });
  it('R1-B: an old-round ACK does not allow a second submission of the new round', async () => {
    const { onSubmit, set } = mount();
    await userEvent.click(send());
    set({ contextKey: r2 });
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    set({ contextKey: r2, feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', order: confirmed('aa', 'bb', 'cc', 'dd') } });
    await userEvent.click(send());
    send().focus();
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
  it('R1-C: the same retry error as a NEW object is no answer; the same error echoing the NEW attempt is', async () => {
    const error = (attemptId: string): OrderingFeedback => ({ contextKey: r1, attemptId, status: 'ERROR', retryable: true, message: 'Bitte erneut versuchen.' });
    const { onSubmit, set } = mount({ feedback: error(`${r1}#0`) });
    await userEvent.click(down('Alpha'));
    await userEvent.click(send()); // attempt #1
    expect(onSubmit).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) set({ feedback: error(`${r1}#0`) }); // re-created, content-identical object
    expect(send()).toBeDisabled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    set({ feedback: error(`${r1}#1`) }); // a real answer to attempt 1
    expect(send()).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Bitte erneut versuchen.');
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']); // order kept
    await userEvent.click(send()); // manual retry = attempt #2
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith(val('bb', 'aa', 'cc', 'dd'), `${r1}#2`);
    set({ feedback: error(`${r1}#1`) }); // identical error of the OLD attempt: still no answer to #2
    expect(send()).toBeDisabled();
    set({ feedback: error(`${r1}#2`) }); // identical error for the NEW attempt: a real answer
    expect(send()).toBeEnabled();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(onSubmit).toHaveBeenCalledTimes(2); // no automatic resend, ever
  });
  it('a retryable error keeps the order editable; a fatal error makes everything read-only and disabled', async () => {
    const a = mount();
    await userEvent.click(send());
    a.set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true, message: 'Netzwerk' } });
    expect(down('Alpha')).toBeEnabled();
    await userEvent.click(down('Alpha'));
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(screen.getByRole('button', { name: 'Erneut senden' })).toBeEnabled();
    a.view.unmount();
    const b = mount();
    await userEvent.click(down('Alpha'));
    await userEvent.click(send());
    b.set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: false, message: 'Die Zeit ist abgelaufen.' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zeit ist abgelaufen.');
    expect(send()).toBeDisabled();
    expect(down('Beta')).toBeDisabled();
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(b.onSubmit).toHaveBeenCalledTimes(1);
  });
  it('null, missing and unattached feedback is "no information" and never unlocks', async () => {
    const { set } = mount();
    await userEvent.click(send());
    set({ feedback: null });
    set({ feedback: undefined });
    set({ feedback: { contextKey: 'run9:other', attemptId: null, status: 'ERROR', retryable: true } });
    set({ feedback: { contextKey: CTX, status: 'ERROR', retryable: true } as unknown as OrderingFeedback }); // no echo of an open attempt
    expect(send()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
  });
  it('ignores feedback of an older attempt, then processes the matching one normally; never regresses within an attempt', async () => {
    const { set } = mount();
    await userEvent.click(send());
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true, message: 'x' } });
    await userEvent.click(send()); // #2
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#1`, status: 'SUBMITTED', order: confirmed('dd', 'cc', 'bb', 'aa') } }); // older: ignored
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#2`, status: 'SUBMITTED', order: confirmed('aa', 'bb', 'cc', 'dd') } });
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#2`, status: 'PENDING' } }); // a late PENDING after SUBMITTED
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
    set({ feedback: { contextKey: CTX, attemptId: `${CTX}#2`, status: 'ERROR', retryable: true } });
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
  });
  it('a real context change resets draft, held feedback and the open attempt; coming back never resurrects them', async () => {
    const { onSubmit, set } = mount();
    await userEvent.click(down('Alpha'));
    await userEvent.click(send());
    set({ contextKey: r2, feedback: null });
    expect(labelsInOrder()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']); // back to the start order
    expect(send()).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(val('aa', 'bb', 'cc', 'dd'), `${r2}#2`);
    set({ contextKey: r1, feedback: null });
    expect(send()).toBeEnabled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(val('aa', 'bb', 'cc', 'dd'), `${r1}#3`);
  });
  it('honours disabled without losing the order', async () => {
    const { set, onSubmit } = mount();
    await userEvent.click(down('Alpha'));
    set({ disabled: true });
    expect(send()).toBeDisabled();
    expect(down('Beta')).toBeDisabled();
    await userEvent.click(down('Beta'));
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    set({ disabled: false });
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(val('bb', 'aa', 'cc', 'dd'), `${CTX}#1`);
  });
});

describe('N3 OrderingForm: round lock keeps the confirmed order and the attempt echo (N2-R1/R2 on the real component)', () => {
  const server = val('cc', 'aa', 'bb', 'dd'); // what the server really accepted
  const setup = () => {
    const onSubmit = vi.fn();
    const base: OrderingFormProps = { config, contextKey: 'r', onSubmit };
    const view = render(<OrderingForm {...base} />);
    const set = (feedback: OrderingFeedback | null, over: Partial<OrderingFormProps> = {}) => view.rerender(<OrderingForm {...base} {...over} feedback={feedback} />);
    return { onSubmit, set };
  };
  /** Attempt r#1 is sent, an uncertain result allows a manual retry with a different local draft (r#2), and the server then
   *  confirms the order it had really accepted. UI attempt and server command are different things. */
  const confirmedAfterRetry = async (h: ReturnType<typeof setup>) => {
    await userEvent.click(down('Alpha')); // draft: Beta, Alpha, Gamma, Delta … but the server accepted `server`
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'ERROR', retryable: true });
    await userEvent.click(down('Delta')); // different local draft
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#2', status: 'SUBMITTED', order: server });
    expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
  };

  it('R2: a current round lock WITHOUT order data keeps the server-confirmed order, not the local draft', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED' });
    expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
    expect(send()).toBeDisabled();
    expect(down('Gamma')).toBeDisabled();
    expect(h.onSubmit).toHaveBeenCalledTimes(2);
  });
  it('the confirmed order replaces a diverging local draft as soon as the server confirms it', async () => {
    const h = setup();
    await userEvent.click(down('Alpha'));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', order: server });
    expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
  });
  it('R1: an older attempt\'s LOCKED — with or without order — never changes the display, before or after the round lock', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'LOCKED', order: val('dd', 'cc', 'bb', 'aa') });
    expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.'); // not even locked by a stale message
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED' });
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'LOCKED', order: val('dd', 'cc', 'bb', 'aa') });
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'LOCKED' });
    h.set({ contextKey: 'r', attemptId: 'r#7', status: 'LOCKED', order: val('dd', 'cc', 'bb', 'aa') });
    expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
  });
  it('a round lock without any confirmed order shows the local draft read-only (also after a PENDING)', async () => {
    const h = setup();
    await userEvent.click(down('Alpha'));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'PENDING' });
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED' });
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
    expect(send()).toBeDisabled();
    expect(down('Beta')).toBeDisabled();
  });
  it('locks the round even before any submit and keeps the draft visible', async () => {
    const h = setup();
    await userEvent.click(down('Alpha'));
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED' });
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(send()).toBeDisabled();
    await userEvent.click(send());
    expect(h.onSubmit).not.toHaveBeenCalled();
  });
  it('LOCKED stays final and keeps the confirmed order: later PENDING/ERROR/SUBMITTED of any attempt change nothing', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED' });
    for (const fb of [{ attemptId: 'r#2', status: 'PENDING' }, { attemptId: 'r#2', status: 'ERROR', retryable: true, message: 'zu spät' },
      { attemptId: 'r#2', status: 'SUBMITTED', order: val('dd', 'cc', 'bb', 'aa') }, { attemptId: null, status: 'SUBMITTED', order: val('dd', 'cc', 'bb', 'aa') }] as const) {
      h.set({ contextKey: 'r', ...fb });
      expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
      expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
    }
    expect(screen.queryByText('zu spät')).not.toBeInTheDocument();
  });
  it('a lock whose attemptId property is missing still is the round lock and keeps the confirmed order', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', status: 'LOCKED' } as unknown as OrderingFeedback);
    expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
  });
  it('an applicable lock WITH an order is authoritative and replaces the previously confirmed one', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED', order: val('dd', 'cc', 'bb', 'aa') });
    expect(labelsInOrder()).toEqual(['Delta', 'Gamma', 'Beta', 'Alpha']);
  });
  it('a real context change clears the confirmed order: no carry-over into the new round, old feedback stays ignored', async () => {
    const h = setup();
    await confirmedAfterRetry(h);
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED' });
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED' }, { contextKey: 'r2' }); // stale feedback of the old context
    expect(labelsInOrder()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(send()).toBeEnabled();
    h.set({ contextKey: 'r2', attemptId: null, status: 'LOCKED' }, { contextKey: 'r2' }); // the new round locks without any order
    expect(labelsInOrder()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(send()).toBeDisabled();
    h.set({ contextKey: 'r2', attemptId: null, status: 'LOCKED' }, { contextKey: 'r' }); // and back: nothing resurrects
    expect(labelsInOrder()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });
  it('a correct current ACK after a previously ignored old ACK is processed normally and sets the confirmed order', async () => {
    const h = setup();
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'ERROR', retryable: true });
    await userEvent.click(send()); // r#2
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', order: val('dd', 'cc', 'bb', 'aa') }); // ignored
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    h.set({ contextKey: 'r', attemptId: 'r#2', status: 'SUBMITTED', order: server });
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
    expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
    h.set({ contextKey: 'r', attemptId: null, status: 'LOCKED' });
    expect(labelsInOrder()).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta']);
  });
  it('a confirmed order that is not a permutation of THIS item set is not displayed or kept', async () => {
    const h = setup();
    await userEvent.click(down('Alpha'));
    await userEvent.click(send());
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', order: val('aa', 'bb', 'cc', 'zz') });
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']); // the local draft, read-only
    expect(screen.queryByText('Delta', { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('zz');
    h.set({ contextKey: 'r', attemptId: 'r#1', status: 'SUBMITTED', order: val('aa', 'bb') });
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
  });
});

describe('N3 OrderingForm: identity, re-render, theme and config robustness', () => {
  it('keeps the draft bound to item ids when the parent re-renders with new equal props objects, other labels or a re-ordered items array', async () => {
    const { set } = mount();
    await userEvent.click(down('Alpha')); // Beta, Alpha, Gamma, Delta
    const before = rows()[1];
    for (let i = 0; i < 3; i++) set({ config: { ...config, items: items.map(d => ({ ...d })) } });
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(rows()[1]).toBe(before); // the same DOM node
    set({ config: { ...config, items: items.map(d => ({ ...d, label: `${d.label}!` })) } });
    expect(labelsInOrder()).toEqual(['Beta!', 'Alpha!', 'Gamma!', 'Delta!']); // new labels, same ids, same positions
    set({ config: { ...config, items: [items[3], items[2], items[1], items[0]] } }); // pure metadata re-ordering of the SAME ids
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']); // the draft is by id, not by index
  });
  it('a CHANGED item set under the same contextKey is a controlled error: nothing is merged, nothing can be sent', async () => {
    const { set, onSubmit } = mount();
    await userEvent.click(down('Alpha'));
    set({ config: { ...config, items: [...items, { itemId: 'ee', label: 'Epsilon', help: null }] } });
    expect(screen.getByRole('alert')).toHaveTextContent('Die Aufgabe hat sich geändert');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(screen.queryByText('Epsilon')).not.toBeInTheDocument();
    await userEvent.click(send());
    expect(onSubmit).not.toHaveBeenCalled();
    // the same context with an accepted order does not pull new items into it either
    set({ config: { ...config, items: [items[0], items[1], items[2], { itemId: 'ee', label: 'Epsilon', help: null }] }, feedback: { contextKey: CTX, attemptId: null, status: 'LOCKED', order: val('aa', 'bb', 'cc', 'dd') } });
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('the same changed set under a NEW contextKey is a clean reset to the new set', async () => {
    const { set, onSubmit } = mount();
    await userEvent.click(down('Alpha'));
    await userEvent.click(send());
    const next: OrderingConfig = { ...config, items: [{ itemId: 'ee', label: 'Epsilon', help: null }, { itemId: 'ff', label: 'Zeta', help: null }] };
    set({ config: next, contextKey: 'run1:round2' });
    expect(labelsInOrder()).toEqual(['Epsilon', 'Zeta']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(send()).toBeEnabled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(val('ee', 'ff'), 'run1:round2#2');
  });
  function Harness({ onSubmit }: { onSubmit: OrderingFormProps['onSubmit'] }) {
    const { setTheme, setAccent } = useTheme();
    return (
      <>
        <button type="button" onClick={() => setTheme('light')}>hell</button>
        <button type="button" onClick={() => setTheme('dark')}>dunkel</button>
        <button type="button" onClick={() => setAccent(ACCENTS[3].id)}>akzent</button>
        <OrderingForm title="Meine Reihenfolge" config={config} contextKey="c" onSubmit={onSubmit} />
      </>
    );
  }
  it('keeps node identity, draft, focus and the submission across theme and accent changes', async () => {
    const onSubmit = vi.fn();
    render(<ThemeProvider><Harness onSubmit={onSubmit} /></ThemeProvider>);
    await userEvent.click(down('Alpha'));
    const node = rows()[1];
    down('Alpha').focus();
    for (const name of ['hell', 'akzent', 'dunkel']) await act(async () => { screen.getByRole('button', { name }).click(); });
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[3].id);
    expect(rows()[1]).toBe(node);
    expect(labelsInOrder()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']);
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(val('bb', 'aa', 'cc', 'dd'), 'c#1');
  });
  it('does not render a config that carries anything beyond the public fields (value, date, solution, reference)', () => {
    for (const extra of [{ sortValue: 3 }, { solution: ['aa'] }, { reference: { groups: [['aa']] } }, { seed: 'geheim' }]) {
      const { unmount } = render(<OrderingForm config={{ ...config, ...extra } as unknown as OrderingConfig} contextKey="c" onSubmit={vi.fn()} />);
      expect(screen.getByRole('alert')).toHaveTextContent('Die Aufgabe kann nicht angezeigt werden.');
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/geheim|sortValue|Alpha/);
      unmount();
    }
    const itemExtra = { ...config, items: [{ ...items[0], year: 1969 }, ...items.slice(1)] } as unknown as OrderingConfig;
    render(<OrderingForm config={itemExtra} contextKey="c" onSubmit={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('1969');
  });
  it('refuses an invalid start list: duplicate ids, a single item, too many items, a wrong version', () => {
    const bad: unknown[] = [
      { ...config, items: [items[0], items[0]] }, { ...config, items: [items[0]] }, { ...config, items: [] },
      { ...config, items: Array.from({ length: 13 }, (_, i) => ({ itemId: `it${i}`, label: `L${i}`, help: null })) },
      { ...config, schemaVersion: 2 }, null, 'x',
    ];
    for (const c of bad) {
      const { unmount } = render(<OrderingForm config={c as OrderingConfig} contextKey="c" onSubmit={vi.fn()} />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      unmount();
    }
  });
  it('renders the smallest and the largest list and very long labels/help as plain wrapping text', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ itemId: `it${i}`, label: `${'Sehr langes Label '.repeat(6)}${i}`, help: 'Hilfe '.repeat(33).trim() }));
    const { unmount } = render(<OrderingForm config={{ ...config, items: many }} contextKey="c" onSubmit={vi.fn()} />);
    expect(rows()).toHaveLength(12);
    const moveNames = screen.getAllByRole('button').filter(b => b.getAttribute('aria-label')).map(b => b.getAttribute('aria-label'));
    expect(moveNames).toHaveLength(24);
    expect(new Set(moveNames).size).toBe(24); // every move button has its own name, also with near-identical long labels
    unmount();
    render(<OrderingForm config={{ ...config, items: items.slice(0, 2) }} contextKey="c" onSubmit={vi.fn()} />);
    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]).getByRole('button', { name: /nach oben/ })).toHaveAttribute('aria-disabled', 'true');
  });
});
