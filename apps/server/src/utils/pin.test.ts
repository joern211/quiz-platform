// Unit tests for PIN hashing
import { describe, it, expect } from 'vitest';

// Inline the PIN hash logic from rooms.ts for testing
import crypto from 'crypto';

function hashPin(pin: string): string {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

function verifyPin(pin: string, hash: string): boolean {
  return hashPin(pin) === hash;
}

describe('PIN hashing', () => {
  it('hashPin produces a 64-character hex string', () => {
    const hash = hashPin('1234');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('same PIN produces same hash (deterministic)', () => {
    const h1 = hashPin('9999');
    const h2 = hashPin('9999');
    expect(h1).toBe(h2);
  });

  it('different PINs produce different hashes', () => {
    const h1 = hashPin('1111');
    const h2 = hashPin('2222');
    expect(h1).not.toBe(h2);
  });

  it('verifyPin returns true for correct PIN', () => {
    const pin = 'secret123';
    const hash = hashPin(pin);
    expect(verifyPin(pin, hash)).toBe(true);
  });

  it('verifyPin returns false for incorrect PIN', () => {
    const pin = 'secret123';
    const hash = hashPin(pin);
    expect(verifyPin('wrong456', hash)).toBe(false);
  });

  it('empty PIN produces a valid hash', () => {
    const hash = hashPin('');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('long PIN produces a valid hash', () => {
    const pin = 'A very long PIN with special chars !@#$%^&*()';
    const hash = hashPin(pin);
    expect(hash).toHaveLength(64);
    expect(verifyPin(pin, hash)).toBe(true);
  });
});
