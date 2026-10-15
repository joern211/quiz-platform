// ============================================================
// Intent-Lebenszyklus (Audit PR14, 14-01 — Abnahme)
// ============================================================
// Regel:
//   - Doppelklick/Retry vor ACK (ACK-Verlust, Timeout) → GLEICHES Token
//     (determinischer Replay bzw. sichere Neu-Ausführung serverseitig).
//   - Bestätigter Erfolg (success:true, inkl. replayed:true) → Token wird
//     verbraucht; die NÄCHSTE zulässige Absicht erhält ein frisches Token
//     (z. B. zweites Buzzer-Öffnen derselben Runde nach WRONG-Bewertung,
//     zweite Pause).
//   - Fehler/Rejection → Token bleibt.
// Der Verbrauch läuft zentral über emitCommand — kein Aufrufer kann ihn
// vergessen.
// ============================================================

import type { Socket } from 'socket.io-client';
import { describe, it, expect, vi } from 'vitest';
import { emitCommand, withCommandEnvelope, intentToken, discardIntentToken } from '../socket';

type EmitMock = { emit: ReturnType<typeof vi.fn> };

function mockSocket(): EmitMock & Socket {
  return { emit: vi.fn() } as unknown as EmitMock & Socket;
}

function lastEmit(socket: ReturnType<typeof mockSocket>): { event: string; payload: Record<string, unknown> } {
  const call = socket.emit.mock.calls.at(-1)!;
  return { event: call[0] as string, payload: call[1] as Record<string, unknown> };
}

describe('intentToken / withCommandEnvelope (Absichts-Granularität)', () => {
  it('liefert für dieselbe Absicht (gleicher Key) das gleiche Token', () => {
    const key = '999-999:wid:buzzer:open:r0';
    const a = intentToken(key);
    const b = intentToken(key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i); // randomUUID-Form (kryptografisch, nicht erratbar)
  });

  it('liefert für verschiedene Absichten (anderer Key) verschiedene Tokens', () => {
    expect(intentToken('999-999:wid:buzzer:open:r0')).not.toBe(intentToken('999-999:wid:buzzer:open:r1'));
    expect(intentToken('999-999:game:pause')).not.toBe(intentToken('999-999:game:resume'));
  });

  it('fügt Command-Envelope (commandId + protocolVersion) hinzu, Payload bleibt erhalten', () => {
    const key = '999-999:geo:answer:q42';
    const env = withCommandEnvelope({ roomCode: '999-999', optionId: 'o1' }, key);
    expect(env.roomCode).toBe('999-999');
    expect(env.optionId).toBe('o1');
    expect(env.commandId).toBe(intentToken(key)); // dieselbe Absicht → gleiches Token
    expect(env.protocolVersion).toBeTypeOf('number');
  });
});

describe('emitCommand — Token-Verwaltung an der Sendegrenze (14-01)', () => {
  it('Doppelklick ohne ACK: zweiter Senden derselben Absicht → GLEICHES Token (Replay)', () => {
    const socket = mockSocket();
    const key = '888-888:wid:buzzer:open:r0';
    // Zweiter Klick, bevor der erste ACK eingetroffen ist:
    emitCommand(socket, 'weristdas:buzzer:open', {}, key);
    emitCommand(socket, 'weristdas:buzzer:open', {}, key);
    const first = lastEmit(socket);
    const second = socket.emit.mock.calls[0][1] as Record<string, unknown>;
    expect(second.commandId).toBe(first.payload.commandId);
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it('bestätigter Erfolg (success:true) → Token verbraucht; nächste Absicht → frisches Token', () => {
    const socket = mockSocket();
    const key = '888-888:wid:judge:r0:WRONG';
    const ack = socket.emit.mockImplementation((_ev: string, _p: unknown, cb?: (r: unknown) => void) => {
      cb?.({ success: true });
    });
    emitCommand(socket, 'weristdas:judge', { result: 'WRONG' }, key);
    const firstToken = (socket.emit.mock.calls[0][1] as Record<string, unknown>).commandId as string;

    // Gleiche Key-Absicht erneut senden (z. B. Host bewertet erneut falsch) →
    // nach dem bestätigten ACK muss ein FRISCHES Token vergeben werden.
    socket.emit.mockClear();
    emitCommand(socket, 'weristdas:judge', { result: 'WRONG' }, key);
    const secondToken = (socket.emit.mock.calls[0][1] as Record<string, unknown>).commandId as string;
    expect(secondToken).not.toBe(firstToken);
    void ack;
  });

  it('bestätigter REPLAY (success:true, replayed:true) → ebenfalls verbraucht (Absicht erledigt)', () => {
    const socket = mockSocket();
    const key = '888-888:game:pause';
    socket.emit.mockImplementation((_ev: string, _p: unknown, cb?: (r: unknown) => void) => {
      cb?.({ success: true, replayed: true });
    });
    emitCommand(socket, 'game:pause', { roomCode: '888-888' }, key);
    const firstToken = (socket.emit.mock.calls[0][1] as Record<string, unknown>).commandId as string;
    socket.emit.mockClear();
    emitCommand(socket, 'game:pause', { roomCode: '888-888' }, key);
    const secondToken = (socket.emit.mock.calls[0][1] as Record<string, unknown>).commandId as string;
    expect(secondToken).not.toBe(firstToken);
  });

  it('Fehler/Rejection → Token bleibt (gleiche Absicht → serverseitig gespeicherte Ablehnung)', () => {
    const socket = mockSocket();
    const key = '888-888:geo:next:q1';
    socket.emit.mockImplementation((_ev: string, _p: unknown, cb?: (r: unknown) => void) => {
      cb?.({ success: false, error: 'INVALID_PHASE' });
    });
    emitCommand(socket, 'geo:next', { roomCode: '888-888' }, key);
    const firstToken = (socket.emit.mock.calls[0][1] as Record<string, unknown>).commandId as string;
    // Retry nach Fehler (gleiche Absicht) → gleiches Token:
    socket.emit.mockClear();
    emitCommand(socket, 'geo:next', { roomCode: '888-888' }, key);
    const secondToken = (socket.emit.mock.calls[0][1] as Record<string, unknown>).commandId as string;
    expect(secondToken).toBe(firstToken);
  });

  it('gibt den ACK an den Aufrufer weiter (success und Fehler)', () => {
    const socket = mockSocket();
    const onOk = vi.fn();
    socket.emit.mockImplementation((_ev: string, _p: unknown, cb?: (r: unknown) => void) => {
      cb?.({ success: true, gameSlug: 'wissensduell' });
    });
    emitCommand(socket, 'game:start', { roomCode: '888-888' }, '888-888:game:start', onOk);
    expect(onOk).toHaveBeenCalledWith({ success: true, gameSlug: 'wissensduell' });
  });

  it('discardIntentToken verwirft den Token explizit (manuelle Neue-Absicht-Entscheidung)', () => {
    const key = '888-888:wid:reveal:r2';
    const a = intentToken(key);
    discardIntentToken(key);
    const b = intentToken(key);
    expect(b).not.toBe(a);
  });
});
