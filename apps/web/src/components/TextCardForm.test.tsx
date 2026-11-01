import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme, ACCENTS } from '@quiz/ui';
import type { TextCardConfig, TextCardValue } from '@quiz/shared/textcard';
import { describe, expect, it, vi } from 'vitest';
import { TextCardForm, textCardIssueMessage, type TextCardFeedback, type TextCardFormProps } from './TextCardForm';

// Synthetic fixture: ids and labels are NOT game presets.
const config: TextCardConfig = {
  schemaVersion: 1, maxCodePointsPerField: 20, maxTotalCodePoints: 45,
  fields: [
    { fieldId: 'alpha', label: 'Eins', help: 'Erste Hilfe', required: true },
    { fieldId: 'beta', label: 'Zwei', help: null, required: false },
    { fieldId: 'gamma', label: 'Drei', help: 'Dritte Hilfe', required: false },
  ],
};
const CTX = 'run1:round1';
const card = (alpha: string | null, beta: string | null = null, gamma: string | null = null): TextCardValue =>
  ({ schemaVersion: 1, answers: [{ fieldId: 'alpha', value: alpha }, { fieldId: 'beta', value: beta }, { fieldId: 'gamma', value: gamma }] });

function mount(props: Partial<TextCardFormProps> = {}) {
  const onSubmit = vi.fn();
  const base: TextCardFormProps = { title: 'Meine Karte', config, contextKey: CTX, onSubmit, ...props };
  const view = render(<TextCardForm {...base} />);
  return { onSubmit, view, base, set: (next: Partial<TextCardFormProps>) => view.rerender(<TextCardForm {...base} {...next} />) };
}
const f = (name: string) => screen.getByLabelText(new RegExp(`^${name}`)) as HTMLInputElement;
const send = () => screen.getByRole('button', { name: /^(Abgeben|Erneut senden)$/ });
const fill = async (name: string, text: string) => { await userEvent.clear(f(name)); await userEvent.type(f(name), text); };
const fb = (over: Partial<TextCardFeedback> & Pick<TextCardFeedback, 'status' | 'attemptId'>): TextCardFeedback => ({ contextKey: CTX, ...over });

describe('N2 TextCardForm: entry, validation, error mapping', () => {
  it('has real labels, public help and the required marker, related through aria-describedby', () => {
    mount();
    expect(screen.getByRole('form', { name: 'Meine Karte' })).toBeInTheDocument();
    expect(f('Eins')).toHaveAccessibleName('Eins (erforderlich)');
    expect(f('Zwei')).toHaveAccessibleName('Zwei');
    expect(f('Eins')).toHaveAccessibleDescription('Erste Hilfe');
    expect(f('Zwei')).not.toHaveAttribute('aria-describedby');
    expect(f('Drei')).toHaveAccessibleDescription('Dritte Hilfe');
  });
  it('submits ONE card with all fields mapped by fieldId; empty optional fields become null, drafts are trimmed', async () => {
    const { onSubmit } = mount();
    await fill('Eins', '  Köln ');
    await fill('Drei', 'Rhein');
    await userEvent.type(f('Zwei'), '   ');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(card('Köln', null, 'Rhein'), `${CTX}#1`);
  });
  it('keeps text lossless: umlauts, emoji and separator characters arrive verbatim in the card', async () => {
    const { onSubmit } = mount();
    await fill('Eins', 'Straße|Ü;ß');
    await fill('Zwei', '😀 {{"a":1}'); // "{{" types a literal brace in user-event
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(card('Straße|Ü;ß', '😀 {"a":1}', null), `${CTX}#1`);
  });
  it('refuses a missing required field at that field, focuses it, keeps every draft and sends nothing', async () => {
    const { onSubmit } = mount();
    await fill('Zwei', 'zwei');
    await userEvent.click(send());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(f('Eins')).toHaveAttribute('aria-invalid', 'true');
    expect(f('Eins')).toHaveFocus();
    expect(f('Eins')).toHaveAccessibleDescription(/Erste Hilfe\s+Dieses Feld ist erforderlich\./);
    expect(f('Zwei')).not.toHaveAttribute('aria-invalid');
    expect(f('Zwei')).toHaveValue('zwei');
    await userEvent.type(f('Eins'), 'x');
    expect(f('Eins')).not.toHaveAttribute('aria-invalid'); // typing clears that field's error
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it('maps several problems to their own fields and focuses the FIRST problematic field; never cuts text', async () => {
    const { onSubmit } = mount();
    await fill('Zwei', 'x'.repeat(25));
    await fill('Drei', 'y'.repeat(21));
    await userEvent.click(send());
    expect(f('Zwei')).toHaveValue('x'.repeat(25)); // no maxLength truncation
    expect(f('Eins')).toHaveFocus(); // alpha is required and empty: first in config order
    expect(f('Eins')).toHaveAttribute('aria-invalid', 'true');
    expect(f('Zwei')).toHaveAccessibleDescription('Höchstens 20 Zeichen.');
    expect(f('Drei')).toHaveAccessibleDescription(/Höchstens 20 Zeichen\./);
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('reports forbidden characters and an oversized total on the right level', async () => {
    const { onSubmit } = mount();
    await fill('Eins', 'a\tb'); // a tab cannot be typed as text into a single-line field via paste of control characters
    await userEvent.click(send());
    expect(f('Eins')).toHaveAccessibleDescription(/nicht erlaubte Zeichen/);
    await fill('Eins', 'a'.repeat(20));
    await fill('Zwei', 'b'.repeat(20));
    await fill('Drei', 'c'.repeat(10));
    await userEvent.click(send());
    expect(screen.getByRole('alert')).toHaveTextContent('Alle Antworten zusammen dürfen höchstens 45 Zeichen lang sein.');
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('gives every issue code a safe, text-free message', () => {
    for (const code of ['TEXT_REQUIRED', 'TEXT_BLANK', 'TEXT_TOO_LONG', 'TEXT_INVALID_CHARACTERS', 'TEXT_TOTAL_TOO_LONG', 'TEXT_MISSING_FIELD', 'TEXT_CARD_MALFORMED', 'SOMETHING_ELSE']) {
      expect(textCardIssueMessage(code, config).length).toBeGreaterThan(5);
    }
  });
  it('accepts an all-optional card with every field empty', async () => {
    const optional: TextCardConfig = { ...config, fields: config.fields.map(d => ({ ...d, required: false })) };
    const { onSubmit } = mount({ config: optional });
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(card(null), `${CTX}#1`);
  });
});

describe('N2 TextCardForm: Enter, IME and single submission', () => {
  it('Enter moves to the next field and only the last field submits the whole card', async () => {
    const { onSubmit } = mount();
    await userEvent.type(f('Eins'), 'a{Enter}');
    expect(f('Zwei')).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(f('Zwei'), 'b{Enter}');
    expect(f('Drei')).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(f('Drei'), 'c{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(card('a', 'b', 'c'), `${CTX}#1`);
  });
  it('ignores Enter during IME composition and submits only after the composition ended', async () => {
    const { onSubmit } = mount();
    await fill('Eins', 'ok');
    await userEvent.click(f('Drei'));
    fireEvent.compositionStart(f('Drei'));
    fireEvent.keyDown(f('Drei'), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(f('Drei'), { key: 'Enter', keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(f('Drei')).toHaveFocus();
    fireEvent.compositionEnd(f('Drei'));
    fireEvent.keyDown(f('Drei'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.click(f('Eins'));
    fireEvent.compositionStart(f('Eins'));
    fireEvent.keyDown(f('Eins'), { key: 'Enter' });
    expect(f('Eins')).toHaveFocus(); // composition active: no jump to the next field either
  });
  it('sends exactly one onSubmit per attempt for Enter, double click and a late PENDING', async () => {
    const { onSubmit, set } = mount();
    await fill('Eins', '1');
    await userEvent.type(f('Drei'), '{Enter}');
    expect(send()).toBeDisabled(); // locked from the valid submit on, before any feedback
    await userEvent.dblClick(send());
    await userEvent.type(f('Drei'), '{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    set({ feedback: fb({ status: 'PENDING', attemptId: `${CTX}#1` }) });
    await userEvent.dblClick(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(f('Eins')).toHaveAttribute('readonly');
  });
});

describe('N2 TextCardForm: feedback and attempt contract (N1-R1 on the real card)', () => {
  const r1 = `run1:round1`, r2 = `run1:round2`;
  const submitted = (units = 'x') => ({ schemaVersion: 1 as const, answers: [{ fieldId: 'alpha', value: units }, { fieldId: 'beta', value: null }, { fieldId: 'gamma', value: null }] });

  it('R1-A: an old-round ACK does not remove the new round\'s pending state or lock', async () => {
    const { onSubmit, set } = mount();
    await fill('Eins', '10');
    await userEvent.click(send());
    set({ contextKey: r2 });
    await fill('Eins', '20');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(card('20'), `${r2}#2`);
    set({ contextKey: r2, feedback: { contextKey: r2, attemptId: `${r2}#2`, status: 'PENDING' } });
    expect(send()).toBeDisabled();
    set({ contextKey: r2, feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', card: submitted('10') } });
    expect(f('Eins')).toHaveValue('20');
    expect(send()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
  });
  it('R1-B: an old-round ACK does not allow a second submission of the new round', async () => {
    const { onSubmit, set } = mount();
    await fill('Eins', '10');
    await userEvent.click(send());
    set({ contextKey: r2 });
    await fill('Eins', '20');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    set({ contextKey: r2, feedback: { contextKey: r1, attemptId: `${r1}#1`, status: 'SUBMITTED', card: submitted('10') } });
    await userEvent.click(send());
    await userEvent.type(f('Eins'), '{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
  it('R1-C: the same retry error as a NEW object is no answer; the same error echoing the NEW attempt is', async () => {
    const error = (attemptId: string): TextCardFeedback => ({ contextKey: r1, attemptId, status: 'ERROR', retryable: true, message: 'Bitte erneut versuchen.' });
    const { onSubmit, set } = mount({ feedback: error(`${r1}#0`) });
    await fill('Eins', '20');
    await userEvent.click(send()); // attempt #1
    expect(onSubmit).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) set({ feedback: error(`${r1}#0`) }); // parent re-renders with a re-created, content-identical object
    expect(send()).toBeDisabled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    set({ feedback: error(`${r1}#1`) }); // a real answer to attempt 1 (identical text, correct echo)
    expect(send()).toBeEnabled();
    await userEvent.click(send()); // manual retry = attempt #2
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith(card('20'), `${r1}#2`);
    set({ feedback: error(`${r1}#1`) }); // identical error of the OLD attempt again: still no answer to #2
    expect(send()).toBeDisabled();
    set({ feedback: error(`${r1}#2`) }); // identical error for the NEW attempt: a real answer
    expect(send()).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Bitte erneut versuchen.');
    expect(f('Eins')).toHaveValue('20'); // draft kept
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(onSubmit).toHaveBeenCalledTimes(2); // no automatic resend, ever
  });
  it('ignores feedback of an older attempt in the same round, then processes the matching one normally', async () => {
    const { set } = mount();
    await fill('Eins', 'a');
    await userEvent.click(send());
    set({ feedback: fb({ status: 'ERROR', attemptId: `${r1}#1`, retryable: true, message: 'Netz weg.' }) });
    await userEvent.click(send()); // attempt #2
    set({ feedback: fb({ status: 'SUBMITTED', attemptId: `${r1}#1`, card: submitted('a') }) }); // late ACK of #1
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
    set({ feedback: fb({ status: 'SUBMITTED', attemptId: `${r1}#2`, card: submitted('a') }) });
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
    expect(f('Eins')).toHaveAttribute('readonly');
  });
  it('an old attempt\'s ACK arriving AFTER the current attempt was answered (PENDING) must not change the current state', async () => {
    const { onSubmit, set } = mount();
    await fill('Eins', 'a');
    await userEvent.click(send());
    set({ feedback: fb({ status: 'ERROR', attemptId: `${r1}#1`, retryable: true, message: 'Netz weg.' }) });
    await userEvent.click(send()); // attempt #2
    set({ feedback: fb({ status: 'PENDING', attemptId: `${r1}#2` }) });
    set({ feedback: fb({ status: 'SUBMITTED', attemptId: `${r1}#1`, card: submitted('a') }) }); // stale ACK of #1
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    expect(send()).toBeDisabled();
    set({ feedback: fb({ status: 'ERROR', attemptId: `${r1}#1`, retryable: true, message: 'alter Fehler' }) }); // stale error of #1
    expect(screen.queryByText('alter Fehler')).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
  it('treats null, missing and unattached feedback as "no information": the lock and the held state stay', async () => {
    const { onSubmit, set } = mount();
    await fill('Eins', 'a');
    await userEvent.click(send());
    set({ feedback: null });
    set({ feedback: undefined });
    set({ feedback: fb({ status: 'ERROR', attemptId: null, retryable: true, message: 'unzuordenbar' }) }); // not an answer to the open attempt
    set({ feedback: fb({ status: 'SUBMITTED', attemptId: null, card: submitted('a') }) });
    expect(send()).toBeDisabled();
    expect(screen.queryByText('Abgegeben.')).not.toBeInTheDocument();
    expect(screen.queryByText('unzuordenbar')).not.toBeInTheDocument();
    set({ feedback: fb({ status: 'PENDING', attemptId: `${r1}#1` }) });
    set({ feedback: null });
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet'); // held PENDING survives a null
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it('never regresses within one attempt: a late PENDING after SUBMITTED, or ERROR after SUBMITTED, is ignored', async () => {
    const { set } = mount();
    await fill('Eins', 'a');
    await userEvent.click(send());
    set({ feedback: fb({ status: 'SUBMITTED', attemptId: `${r1}#1`, card: submitted('a') }) });
    set({ feedback: fb({ status: 'PENDING', attemptId: `${r1}#1` }) });
    set({ feedback: fb({ status: 'ERROR', attemptId: `${r1}#1`, retryable: true, message: 'zu spät' }) });
    expect(screen.getByRole('status')).toHaveTextContent('Abgegeben.');
    expect(screen.queryByText('zu spät')).not.toBeInTheDocument();
  });
  it('shows the server-confirmed card; LOCKED (round lock, no attempt) wins and is final', async () => {
    const { set } = mount();
    await fill('Eins', 'draft');
    await userEvent.click(send());
    set({ feedback: fb({ status: 'LOCKED', attemptId: null, card: submitted('bestätigt') }) });
    expect(f('Eins')).toHaveValue('bestätigt');
    expect(f('Eins')).toHaveAttribute('readonly');
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
    expect(send()).toBeDisabled();
    set({ feedback: fb({ status: 'ERROR', attemptId: `${r1}#1`, retryable: true, message: 'egal' }) });
    set({ feedback: fb({ status: 'PENDING', attemptId: `${r1}#1` }) });
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
  });
  it('locks the round even before any submit and keeps the drafts visible', async () => {
    const { onSubmit, set } = mount();
    await fill('Zwei', 'noch nicht abgegeben');
    set({ feedback: fb({ status: 'LOCKED', attemptId: null }) });
    expect(f('Zwei')).toHaveValue('noch nicht abgegeben');
    expect(f('Zwei')).toHaveAttribute('readonly');
    expect(send()).toBeDisabled();
    await userEvent.type(f('Zwei'), 'x');
    expect(f('Zwei')).toHaveValue('noch nicht abgegeben');
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('makes a non-retryable error final but keeps the drafts; maps server field errors to their fields without texts', async () => {
    const { set } = mount();
    await fill('Eins', 'a');
    await fill('Drei', 'c');
    await userEvent.click(send());
    set({ feedback: fb({ status: 'ERROR', attemptId: `${r1}#1`, retryable: true, fieldErrors: [{ fieldId: 'gamma', code: 'TEXT_INVALID_CHARACTERS' }] }) });
    expect(f('Drei')).toHaveAttribute('aria-invalid', 'true');
    expect(f('Drei')).toHaveAccessibleDescription(/nicht erlaubte Zeichen/);
    expect(screen.getByRole('alert')).toHaveTextContent('Bitte prüfe die markierten Felder.');
    expect(f('Eins')).not.toHaveAttribute('aria-invalid');
    await userEvent.click(send()); // retry #2
    expect(f('Drei')).not.toHaveAttribute('aria-invalid'); // errors of the old attempt are not shown while the new one is open
    set({ feedback: fb({ status: 'ERROR', attemptId: `${r1}#2`, retryable: false, message: 'Die Zeit ist abgelaufen.' }) });
    expect(screen.getByRole('alert')).toHaveTextContent('Die Zeit ist abgelaufen.');
    expect(f('Eins')).toHaveAttribute('readonly');
    expect(f('Eins')).toHaveValue('a');
    expect(send()).toBeDisabled();
  });
  it('a real context change resets drafts, held feedback and the open attempt; coming back never resurrects them', async () => {
    const { onSubmit, set } = mount();
    await fill('Eins', 'alt');
    await userEvent.click(send());
    set({ feedback: fb({ status: 'PENDING', attemptId: `${r1}#1` }) });
    expect(send()).toBeDisabled();
    set({ contextKey: r2, feedback: fb({ status: 'PENDING', attemptId: `${r1}#1` }) });
    expect(f('Eins')).toHaveValue('');
    expect(send()).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await fill('Eins', 'neu');
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenLastCalledWith(card('neu'), `${r2}#2`);
    set({ contextKey: r1 });
    expect(f('Eins')).toHaveValue('');
    expect(send()).toBeEnabled();
  });
  it('honours disabled without losing drafts', async () => {
    const { onSubmit, set } = mount();
    await fill('Eins', 'bleibt');
    set({ disabled: true });
    expect(f('Eins')).toBeDisabled();
    expect(f('Eins')).toHaveValue('bleibt');
    expect(send()).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('N2 TextCardForm: self-review regressions', () => {
  it('an IME composition that never ends (focus left the field) does not block Enter forever', async () => {
    const { onSubmit } = mount();
    await fill('Eins', 'ok');
    await userEvent.click(f('Drei'));
    fireEvent.compositionStart(f('Drei')); // no compositionEnd will ever arrive
    await userEvent.click(f('Zwei')); // focus leaves: blur
    await userEvent.click(f('Drei'));
    fireEvent.keyDown(f('Drei'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it('focuses the first field named by a server error once, and a parent re-render with the same content never steals focus', async () => {
    const error = (): TextCardFeedback => ({ contextKey: CTX, attemptId: `${CTX}#1`, status: 'ERROR', retryable: true,
      fieldErrors: [{ fieldId: 'gamma', code: 'TEXT_INVALID_CHARACTERS' }, { fieldId: 'beta', code: 'TEXT_TOO_LONG' }] });
    const { set } = mount();
    await fill('Eins', 'a');
    await userEvent.click(send());
    set({ feedback: error() });
    expect(f('Zwei')).toHaveFocus(); // first in config order among the reported fields
    await userEvent.click(f('Eins'));
    set({ feedback: error() }); // re-created, content-identical object
    set({ feedback: error() });
    expect(f('Eins')).toHaveFocus();
  });
  it('does not render a config that carries anything beyond the public fields (e.g. a reference by mistake)', () => {
    const leaky = { ...config, fields: [{ ...config.fields[0], reference: 'GEHEIME-LOESUNG', synonyms: ['SYN'] }] } as unknown as TextCardConfig;
    mount({ config: leaky });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Die Karte kann nicht angezeigt werden.');
    expect(document.body.textContent).not.toMatch(/GEHEIME-LOESUNG|SYN/);
    const dup = { ...config, fields: [config.fields[0], config.fields[0]] } as TextCardConfig;
    mount({ config: dup });
    expect(screen.getAllByRole('alert').length).toBe(2);
  });
  it('treats a round lock whose attemptId property is missing like null (never an echo, still the lock)', async () => {
    const { set } = mount();
    await fill('Eins', 'a');
    await userEvent.click(send());
    set({ feedback: { contextKey: CTX, status: 'LOCKED' } as unknown as TextCardFeedback });
    expect(screen.getByRole('status')).toHaveTextContent('gesperrt');
    expect(f('Eins')).toHaveAttribute('readonly');
  });
});

describe('N2 TextCardForm: identity, re-render and theme robustness', () => {
  it('keeps drafts bound to fieldId when the field order changes; the card follows the new order, values never swap', async () => {
    const { onSubmit, set } = mount();
    await fill('Eins', 'eins');
    await fill('Zwei', 'zwei');
    await fill('Drei', 'drei');
    const [a, b, c] = config.fields;
    set({ config: { ...config, fields: [c, a, b] } });
    expect(screen.getAllByRole('textbox').map(el => (el as HTMLInputElement).value)).toEqual(['drei', 'eins', 'zwei']);
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith({ schemaVersion: 1, answers: [{ fieldId: 'gamma', value: 'drei' }, { fieldId: 'alpha', value: 'eins' }, { fieldId: 'beta', value: 'zwei' }] }, `${CTX}#1`);
  });
  it('keeps the same input nodes and drafts across parent re-renders with new props objects', async () => {
    const { set } = mount();
    const before = f('Eins');
    await userEvent.type(before, 'bleibt');
    for (let i = 0; i < 3; i++) set({ config: { ...config, fields: config.fields.map(d => ({ ...d })) }, title: 'Meine Karte' });
    expect(f('Eins')).toBe(before);
    expect(f('Eins')).toHaveValue('bleibt');
    expect(before).toHaveFocus();
  });
  function Harness({ onSubmit }: { onSubmit: (card: TextCardValue, attemptId: string) => void }) {
    const { setTheme, setAccent } = useTheme();
    return (
      <>
        <button type="button" onClick={() => setTheme('light')}>hell</button>
        <button type="button" onClick={() => setTheme('dark')}>dunkel</button>
        <button type="button" onClick={() => setAccent(ACCENTS[3].id)}>akzent</button>
        <TextCardForm title="Meine Karte" config={config} contextKey="c" onSubmit={onSubmit} />
      </>
    );
  }
  it('keeps node identity, drafts, focus and submissions across theme and accent changes', async () => {
    const onSubmit = vi.fn();
    render(<ThemeProvider><Harness onSubmit={onSubmit} /></ThemeProvider>);
    const before = f('Eins');
    await userEvent.type(before, 'bleibt');
    await userEvent.type(f('Zwei'), 'auch');
    expect(f('Zwei')).toHaveFocus();
    for (const name of ['hell', 'akzent', 'dunkel']) await act(async () => { screen.getByRole('button', { name }).click(); });
    expect(document.documentElement.dataset.accent).toBe(ACCENTS[3].id);
    expect(f('Eins')).toBe(before);
    expect(f('Eins')).toHaveValue('bleibt');
    expect(f('Zwei')).toHaveValue('auch');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(send());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it('renders many fields and long titles/labels/help as plain wrapping text with unique ids', () => {
    const many: TextCardConfig = { ...config, maxTotalCodePoints: 1200, fields: Array.from({ length: 12 }, (_, i) => ({
      fieldId: `f${i}`, label: `Ein sehr langer Feldtitel, der mehrfach umbrechen muss ${i}`, help: 'Eine ebenso lange Hilfe, die in schmalen Fenstern umbricht und nichts sprengen darf.', required: i === 0 })) };
    mount({ config: many, title: 'Eine Karte mit sehr vielen erlaubten Feldern und einem langen Titel' });
    const ids = screen.getAllByRole('textbox').map(el => el.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(screen.getByRole('button', { name: 'Abgeben' })).toBeInTheDocument();
  });
  function Stateful() {
    const [feedback, setFeedback] = useState<TextCardFeedback | null>(null);
    return <TextCardForm config={config} contextKey="s" feedback={feedback} onSubmit={(_card, attemptId) => setFeedback({ contextKey: 's', attemptId, status: 'PENDING' })} />;
  }
  it('works with a parent that answers synchronously from inside onSubmit', async () => {
    render(<Stateful />);
    await userEvent.type(f('Eins'), 'x');
    await userEvent.type(f('Drei'), '{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('Wird gesendet');
    expect(send()).toBeDisabled();
  });
});
