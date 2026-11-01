import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, ACCENTS } from '@quiz/ui';
import { projectNumericPublicInput, type NumericInputConfig, type NumericPublicInput, type NumericValue } from '@quiz/shared/numeric';
import { describe, expect, it, vi } from 'vitest';
import { NumberField, numericErrorMessage, type NumberFieldFeedback, type NumberFieldProps } from './NumberField';

const v = (units: number, scale: 0 | 1 = 0): NumericValue => ({ units, scale });
const config = (over: Partial<NumericInputConfig> = {}): NumericInputConfig => ({ schemaVersion: 1, scale: 0, min: v(-100), max: v(1000), unit: null, boundsDisclosure: 'PUBLIC', ...over });
const meta = (over: Partial<NumericInputConfig> = {}): NumericPublicInput => projectNumericPublicInput(config(over));
function mount(props: Partial<NumberFieldProps> = {}) {
  const onSubmit = vi.fn();
  const base: NumberFieldProps = { label: 'Deine Schätzung', input: meta(), contextKey: 'run1:round1', onSubmit, ...props };
  const view = render(<NumberField {...base} />);
  return { onSubmit, view, rerender: (next: Partial<NumberFieldProps>) => view.rerender(<NumberField {...base} {...next} />) };
}
const field = () => screen.getByLabelText('Deine Schätzung') as HTMLInputElement;
const send = () => screen.getByRole('button', { name: /^(Abgeben|Erneut senden)$/ });

describe('N1 NumberField: entry and validation', () => {
  it('has a real label, describes unit and rules, and offers the right keyboard', () => {
    mount({ input: meta({ unit: { label: 'Mio. Euro', factor: 1_000_000 }, scale: 1, min: v(0, 1), max: v(100, 1) }) });
    expect(field()).toHaveAttribute('inputmode', 'decimal');
    expect(field()).toHaveAttribute('type', 'text');
    const described = (field().getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent);
    expect(described.join(' ')).toContain('Mio. Euro');
    expect(described.join(' ')).not.toContain('..');
    expect(described.join(' ')).toContain('Eine Nachkommastelle');
    expect(described.join(' ')).toContain('Erlaubt: 0,0 bis 10,0');
  });
  it('switches to the full keyboard where a minus sign is needed (iOS number pads have none)', () => {
    mount({ input: meta() });
    expect(field()).toHaveAttribute('inputmode', 'text');
    mount({ input: meta({ min: v(0) }) });
    expect(screen.getAllByLabelText('Deine Schätzung')[1]).toHaveAttribute('inputmode', 'numeric');
  });
  it('keeps empty and 0 apart: empty is refused with a field error, a typed 0 is submitted', async () => {
    const { onSubmit } = mount();
    await userEvent.click(send());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Bitte gib eine Zahl ein.');
    expect(field().getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
    await userEvent.type(field(), '0');
    expect(field()).not.toHaveAttribute('aria-invalid');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(v(0), expect.stringMatching(/#\d+$/));
  });
  it('submits negative numbers and comma/dot decimals as the canonical value', async () => {
    const a = mount();
    await userEvent.type(field(), '-25');
    await userEvent.click(send());
    expect(a.onSubmit).toHaveBeenCalledWith(v(-25), expect.stringMatching(/#\d+$/));
    a.view.unmount();
    const b = mount({ input: meta({ scale: 1, min: v(-1000, 1), max: v(1000, 1) }) });
    await userEvent.type(field(), '12,5');
    await userEvent.click(send());
    expect(b.onSubmit).toHaveBeenLastCalledWith(v(125, 1), expect.stringMatching(/#\d+$/));
    await act(async () => b.rerender({ contextKey: 'next' }));
    await userEvent.type(field(), '12.5');
    await userEvent.click(send());
    expect(b.onSubmit).toHaveBeenLastCalledWith(v(125, 1), expect.stringMatching(/#\d+$/));
  });
  it('rejects invalid input visibly, keeps the draft verbatim and never calls onSubmit', async () => {
    const { onSubmit } = mount();
    for (const [text, message] of [['12abc', /nur Ziffern/], ['1.234', /nur ganze Zahlen/i], ['-', /nicht vollständig/], ['5000', /zwischen −100 und 1000/]] as const) {
      await userEvent.clear(field());
      await userEvent.type(field(), text);
      await userEvent.click(send());
      expect(field()).toHaveValue(text);
      expect(screen.getByRole('alert')).toHaveTextContent(message);
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('does not reveal private bounds in error texts', async () => {
    const privateMeta = meta({ boundsDisclosure: 'PRIVATE', min: v(0), max: v(4242) });
    mount({ input: privateMeta });
    await userEvent.type(field(), '-1');
    await userEvent.click(send());
    expect(screen.getByRole('alert').textContent).not.toMatch(/4242|\d/);
    expect(document.body.textContent).not.toContain('4242');
    expect(numericErrorMessage('NUMERIC_OUT_OF_RANGE', privateMeta)).not.toMatch(/\d/);
  });
  it('is usable by keyboard alone: type, Enter submits exactly once', async () => {
    const { onSubmit } = mount();
    await userEvent.tab();
    expect(field()).toHaveFocus();
    await userEvent.keyboard('42{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(v(42), expect.stringMatching(/#\d+$/));
    await userEvent.keyboard('{Enter}');
    await userEvent.dblClick(send());
    expect(onSubmit).toHaveBeenCalledTimes(1); // waits for the caller's feedback; never resends by itself
  });
});

describe('N1 NumberField: caller-owned feedback', () => {
  const key = 'run1:round1';
  const fb = (over: Partial<NumberFieldFeedback>): NumberFieldFeedback => ({ contextKey: key, status: 'PENDING', ...over });

  it('shows success only after the caller confirms; pending keeps the draft and blocks edits and a second send', async () => {
    const { onSubmit, rerender } = mount();
    await userEvent.type(field(), '7');
    await userEvent.click(send());
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    await act(async () => rerender({ feedback: fb({ status: 'PENDING' }) }));
    expect(field()).toHaveValue('7');
    expect(field()).toHaveAttribute('readonly');
    expect(send()).toBeDisabled();
    expect(send()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    await userEvent.type(field(), '9');
    expect(field()).toHaveValue('7');
    await act(async () => rerender({ feedback: fb({ status: 'SUBMITTED', value: v(7) }) }));
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
    expect(send()).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it('shows the server-confirmed value and a read-only locked state', async () => {
    const { rerender } = mount({ input: meta({ scale: 1, min: v(-100, 1), max: v(1000, 1) }) });
    await userEvent.type(field(), '3');
    await act(async () => rerender({ feedback: fb({ status: 'LOCKED', value: v(35, 1) }) }));
    expect(field()).toHaveValue('3,5');
    expect(field()).toHaveAttribute('readonly');
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
    expect(send()).toBeDisabled();
  });
  it('keeps the draft on a retryable error and lets the user — not a loop — send again', async () => {
    const { onSubmit, rerender } = mount();
    await userEvent.type(field(), '88');
    await userEvent.click(send());
    await act(async () => rerender({ feedback: fb({ status: 'PENDING' }) }));
    const failure = fb({ status: 'ERROR', retryable: true, message: 'Zu viele Anfragen. Bitte kurz warten.' });
    await act(async () => rerender({ feedback: failure }));
    expect(screen.getByRole('alert')).toHaveTextContent('Zu viele Anfragen');
    expect(field()).toHaveValue('88');
    expect(field()).not.toHaveAttribute('readonly');
    expect(send()).toHaveTextContent('Erneut senden');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(onSubmit).toHaveBeenCalledTimes(1); // no automatic resend
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith(v(88), expect.stringMatching(/#\d+$/));
  });
  it('makes the field read-only on a non-retryable error but keeps the draft visible', async () => {
    const { rerender } = mount();
    await userEvent.type(field(), '5');
    await act(async () => rerender({ feedback: fb({ status: 'ERROR', retryable: false, message: 'Die Zeit ist abgelaufen.' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zeit ist abgelaufen.');
    expect(field()).toHaveValue('5');
    expect(field()).toHaveAttribute('readonly');
    expect(send()).toBeDisabled();
  });
  it('resets on a new round and ignores late feedback of the old one', async () => {
    const { onSubmit, rerender } = mount();
    await userEvent.type(field(), '12');
    await userEvent.click(send());
    await act(async () => rerender({ feedback: fb({ status: 'PENDING' }) }));
    await act(async () => rerender({ contextKey: 'run1:round2', feedback: fb({ status: 'PENDING' }) }));
    expect(field()).toHaveValue('');
    expect(field()).not.toHaveAttribute('readonly');
    expect(send()).not.toBeDisabled();
    await act(async () => rerender({ contextKey: 'run1:round2', feedback: fb({ status: 'SUBMITTED', value: v(12) }) })); // late ACK of round 1
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    expect(field()).toHaveValue('');
    await act(async () => rerender({ contextKey: 'run1:round2', feedback: fb({ contextKey: 'run1:round2', status: 'ERROR', retryable: true, message: 'Fehler in Runde 2' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent('Fehler in Runde 2');
    await userEvent.type(field(), '3');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(v(3), expect.stringMatching(/#\d+$/));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
  it('honours the disabled prop without losing the draft', async () => {
    const { onSubmit, rerender } = mount();
    await userEvent.type(field(), '9');
    await act(async () => rerender({ disabled: true }));
    expect(field()).toBeDisabled();
    expect(field()).toHaveValue('9');
    expect(send()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('N1 NumberField: theme and layout robustness', () => {
  function Harness({ onSubmit }: { onSubmit: (value: NumericValue) => void }) {
    const { setTheme, setAccent } = useTheme();
    const [extra, setExtra] = useState(0);
    return (
      <>
        <button type="button" onClick={() => setTheme('light')}>hell</button>
        <button type="button" onClick={() => setTheme('dark')}>dunkel</button>
        <button type="button" onClick={() => setAccent(ACCENTS[2].id)}>akzent</button>
        <button type="button" onClick={() => setExtra(extra + 1)}>rerender {extra}</button>
        <NumberField label="Deine Schätzung" input={meta({ unit: { label: 'Millionen Einwohner in der Metropolregion Hamburg', factor: 1_000_000 } })} contextKey="c" onSubmit={onSubmit} />
      </>
    );
  }
  it('keeps node identity, draft, focus and submissions across theme and accent changes', async () => {
    const onSubmit = vi.fn();
    render(<ThemeProvider><Harness onSubmit={onSubmit} /></ThemeProvider>);
    const before = field();
    await userEvent.type(before, '-17');
    expect(before).toHaveFocus();
    for (const name of ['hell', 'akzent', 'dunkel']) {
      await act(async () => { screen.getByRole('button', { name }).click(); });
    }
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[2].id);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(field()).toBe(before);
    expect(field()).toHaveValue('-17');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(v(-17), expect.stringMatching(/#\d+$/));
  });
  it('renders very long labels and units as plain wrapping text (no truncation by script)', () => {
    mount({ label: 'Deine Schätzung', input: meta({ unit: { label: 'Millionen Einwohner in der Metropolregion Hamburg', factor: 1_000_000 } }) });
    expect(screen.getAllByText(/Millionen Einwohner in der Metropolregion Hamburg/).length).toBeGreaterThan(0);
  });
});

// R1 (independent review of PR #30): the send lock belongs to the CURRENT attempt in the CURRENT context.
// Stale or merely re-created feedback objects must never release it or change the pending/confirmed state.
describe('N1 NumberField R1: current submission survives stale and re-created feedback', () => {
  const rInput: NumberFieldProps['input'] = {
    schemaVersion: 1, scale: 0, unit: null, allowNegative: true,
    bounds: { min: { units: -100, scale: 0 }, max: { units: 100, scale: 0 } },
  };
  const rField = () => screen.getByLabelText('Schätzung');
  const rButton = () => screen.getByRole('button', { name: /Abgeben|Erneut senden/ });

  it('keeps a new-round pending submission blocked when a previous-round ACK arrives', async () => {
    const onSubmit = vi.fn();
    const base: NumberFieldProps = { label: 'Schätzung', input: rInput, contextKey: 'run1:round1', onSubmit };
    const view = render(<NumberField {...base} />);
    await userEvent.type(rField(), '10');
    await userEvent.click(rButton());
    view.rerender(<NumberField {...base} contextKey="run1:round2" />);
    await userEvent.type(rField(), '20');
    await userEvent.click(rButton());
    view.rerender(<NumberField {...base} contextKey="run1:round2" feedback={{ contextKey: 'run1:round2', status: 'PENDING' }} />);
    expect(rButton()).toBeDisabled();
    view.rerender(<NumberField {...base} contextKey="run1:round2" feedback={{ contextKey: 'run1:round1', status: 'SUBMITTED', value: { units: 10, scale: 0 } }} />);
    expect(rField()).toHaveValue('20');
    expect(rButton()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
  });

  it('does not allow a second new-round submit after an ignored old-round ACK', async () => {
    const onSubmit = vi.fn();
    const base: NumberFieldProps = { label: 'Schätzung', input: rInput, contextKey: 'run1:round1', onSubmit };
    const view = render(<NumberField {...base} />);
    await userEvent.type(rField(), '10');
    await userEvent.click(rButton());
    view.rerender(<NumberField {...base} contextKey="run1:round2" />);
    await userEvent.type(rField(), '20');
    await userEvent.click(rButton());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    view.rerender(<NumberField {...base} contextKey="run1:round2" feedback={{ contextKey: 'run1:round1', status: 'SUBMITTED', value: { units: 10, scale: 0 } }} />);
    await userEvent.click(rButton());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('does not treat a parent rerender with the same retry error as acknowledgement of the retry', async () => {
    const onSubmit = vi.fn();
    const base: NumberFieldProps = { label: 'Schätzung', input: rInput, contextKey: 'run1:round1', onSubmit,
      feedback: { contextKey: 'run1:round1', status: 'ERROR', retryable: true, message: 'Bitte erneut versuchen.' } };
    const view = render(<NumberField {...base} />);
    await userEvent.type(rField(), '20');
    await userEvent.click(rButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    view.rerender(<NumberField {...base} feedback={{ ...base.feedback! }} />);
    await userEvent.click(rButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  const mk = (onSubmit = vi.fn(), over: Partial<NumberFieldProps> = {}) => {
    const base: NumberFieldProps = { label: 'Schätzung', input: rInput, contextKey: 'run1:round1', onSubmit, ...over };
    const view = render(<NumberField {...base} />);
    return { onSubmit, base, view, set: (next: Partial<NumberFieldProps>) => view.rerender(<NumberField {...base} {...next} />) };
  };
  const ok = (contextKey: string, units: number): NumberFieldFeedback => ({ contextKey, status: 'SUBMITTED', value: { units, scale: 0 } });

  it('processes the matching current answer normally after an ignored old ACK', async () => {
    const { onSubmit, set } = mk();
    await userEvent.type(rField(), '10');
    await userEvent.click(rButton());
    set({ contextKey: 'run1:round2' });
    await userEvent.type(rField(), '20');
    await userEvent.click(rButton());
    set({ contextKey: 'run1:round2', feedback: ok('run1:round1', 10) });
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    set({ contextKey: 'run1:round2', feedback: ok('run1:round2', 20) });
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
    expect(rField()).toHaveValue('20');
    expect(rButton()).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('locks from the valid submit on, even if the parent delivers PENDING late, and unlocks only by a real answer', async () => {
    const { onSubmit, set } = mk();
    await userEvent.type(rField(), '5');
    await userEvent.click(rButton());
    expect(rButton()).toBeDisabled(); // before any feedback
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    set({ feedback: { contextKey: 'run1:round1', status: 'PENDING' } });
    expect(rButton()).toBeDisabled();
    set({ feedback: { contextKey: 'run1:round1', status: 'ERROR', retryable: true, message: 'Netzwerkfehler' } });
    expect(rButton()).toBeEnabled();
    expect(rField()).toHaveValue('5');
  });

  it('a context change clears the old attempt: no lock, no draft, no held feedback carry over', async () => {
    const { onSubmit, set } = mk();
    await userEvent.type(rField(), '7');
    await userEvent.click(rButton());
    set({ feedback: { contextKey: 'run1:round1', status: 'PENDING' } });
    expect(rButton()).toBeDisabled();
    set({ contextKey: 'run1:round2', feedback: { contextKey: 'run1:round1', status: 'PENDING' } });
    expect(rField()).toHaveValue('');
    expect(rButton()).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.type(rField(), '8');
    await userEvent.click(rButton());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({ units: 8, scale: 0 }, 'run1:round2#2');
    set({ contextKey: 'run1:round1' }); // coming back never resurrects the old attempt
    expect(rField()).toHaveValue('');
    expect(rButton()).toBeEnabled();
  });

  it('repeated identical ERROR feedback neither unlocks nor submits automatically', async () => {
    const error = { contextKey: 'run1:round1', status: 'ERROR', retryable: true, message: 'Bitte erneut versuchen.' } as const;
    const { onSubmit, set } = mk(vi.fn(), { feedback: { ...error } });
    await userEvent.type(rField(), '20');
    await userEvent.click(rButton());
    for (let i = 0; i < 5; i++) set({ feedback: { ...error } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(rButton()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // the old error is not shown as the answer to the retry
    set({ feedback: { contextKey: 'run1:round1', status: 'PENDING' } });
    set({ feedback: { ...error } }); // PENDING → the same error again is now a real answer to the retry
    expect(rButton()).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Bitte erneut versuchen.');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps the held state when the parent passes null or a stale object (no new information)', async () => {
    const { set } = mk();
    await userEvent.type(rField(), '3');
    await userEvent.click(rButton());
    set({ feedback: { contextKey: 'run1:round1', status: 'PENDING' } });
    set({ feedback: null });
    expect(rButton()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    set({ feedback: undefined });
    expect(rButton()).toBeDisabled();
    set({ feedback: ok('other-run', 3) });
    expect(rButton()).toBeDisabled();
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
  });

  it('attempt contract: onSubmit hands out <contextKey>#<n>; only the current attempt\'s echo counts', async () => {
    const { onSubmit, set } = mk();
    await userEvent.type(rField(), '1');
    await userEvent.click(rButton());
    expect(onSubmit).toHaveBeenLastCalledWith({ units: 1, scale: 0 }, 'run1:round1#1');
    const sameError = { contextKey: 'run1:round1', status: 'ERROR', retryable: true, message: 'Zu viele Anfragen.' } as const;
    set({ feedback: { ...sameError, attemptId: 'run1:round1#1' } });
    expect(rButton()).toBeEnabled();
    await userEvent.click(rButton());
    expect(onSubmit).toHaveBeenLastCalledWith({ units: 1, scale: 0 }, 'run1:round1#2');
    // identical error content, but echoing the OLD attempt: ignored
    set({ feedback: { ...sameError, attemptId: 'run1:round1#1' } });
    expect(rButton()).toBeDisabled();
    // identical error content for the CURRENT attempt: a real answer (no PENDING needed)
    set({ feedback: { ...sameError, attemptId: 'run1:round1#2' } });
    expect(rButton()).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Zu viele Anfragen.');
    await userEvent.click(rButton());
    expect(onSubmit).toHaveBeenCalledTimes(3);
    // a late answer of attempt 2 must not touch attempt 3
    set({ feedback: { contextKey: 'run1:round1', status: 'SUBMITTED', value: { units: 1, scale: 0 }, attemptId: 'run1:round1#2' } });
    expect(rButton()).toBeDisabled();
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    set({ feedback: { contextKey: 'run1:round1', status: 'SUBMITTED', value: { units: 1, scale: 0 }, attemptId: 'run1:round1#3' } });
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
  });

  it('LOCKED and a non-retryable error still take effect after a stale ACK was ignored', async () => {
    const a = mk();
    await userEvent.type(rField(), '4');
    await userEvent.click(rButton());
    a.set({ feedback: ok('run0:round9', 4) });
    a.set({ feedback: { contextKey: 'run1:round1', status: 'LOCKED', value: { units: 4, scale: 0 } } });
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
    expect(rField()).toHaveAttribute('readonly');
    a.view.unmount();
    const b = mk();
    await userEvent.type(rField(), '4');
    await userEvent.click(rButton());
    b.set({ feedback: ok('run0:round9', 4) });
    b.set({ feedback: { contextKey: 'run1:round1', status: 'ERROR', retryable: false, message: 'Die Zeit ist abgelaufen.' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zeit ist abgelaufen.');
    expect(rField()).toHaveAttribute('readonly');
    expect(rButton()).toBeDisabled();
    expect(rField()).toHaveValue('4');
  });
});
