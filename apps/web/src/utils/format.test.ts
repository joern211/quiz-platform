// Unit tests for format utilities
import { describe, it, expect } from 'vitest';

// Inline format utilities for testing
function normalizeRoomCode(code: string): string {
  // Strip all non-digits, then insert dash in middle
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) {
    return code; // Return as-is if not 6 digits
  }
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function formatScore(score: number): string {
  if (score >= 10000) return score.toLocaleString('de-DE');
  return score.toString();
}

describe('normalizeRoomCode', () => {
  it('passes through already-formatted NNN-NNN', () => {
    expect(normalizeRoomCode('123-456')).toBe('123-456');
  });

  it('normalizes 6 digits without dash to NNN-NNN', () => {
    expect(normalizeRoomCode('123456')).toBe('123-456');
  });

  it('normalizes spaced digits to NNN-NNN', () => {
    expect(normalizeRoomCode('123 456')).toBe('123-456');
  });

  it('normalizes mixed input to NNN-NNN', () => {
    expect(normalizeRoomCode('abc123def456ghi')).toBe('123-456');
  });

  it('returns original string for non-6-digit input', () => {
    expect(normalizeRoomCode('12345')).toBe('12345');
    expect(normalizeRoomCode('1234567')).toBe('1234567');
  });

  it('handles leading zeros', () => {
    expect(normalizeRoomCode('000123')).toBe('000-123');
    expect(normalizeRoomCode('000-123')).toBe('000-123');
  });
});

describe('formatScore', () => {
  it('formats small scores as-is', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(42)).toBe('42');
    expect(formatScore(999)).toBe('999');
  });

  it('returns numbers as-is for scores below 10000', () => {
    expect(formatScore(1000)).toBe('1000');
  });

  it('formats large scores with locale separator', () => {
    expect(formatScore(50000)).toBe('50.000');
    expect(formatScore(1234567)).toBe('1.234.567');
  });
});
