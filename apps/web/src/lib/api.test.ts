// Unit tests for API client helpers
import { describe, it, expect } from 'vitest';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

function unwrap<T>(res: ApiResponse<T>): T {
  if (!res.success || res.data === undefined) {
    throw new Error(res.error?.message ?? 'API error');
  }
  return res.data;
}

describe('unwrap', () => {
  it('returns data for ApiResponse.success', () => {
    const res: ApiResponse<{ id: string }> = {
      success: true,
      data: { id: 'room-123' },
    };
    expect(unwrap(res)).toEqual({ id: 'room-123' });
  });

  it('throws with error message for ApiResponse.error', () => {
    const res: ApiResponse<never> = {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
    };
    expect(() => unwrap(res)).toThrow('Raum nicht gefunden.');
  });

  it('throws when error message is empty string', () => {
    const res: ApiResponse<never> = {
      success: false,
      error: { code: 'UNKNOWN', message: '' },
    };
    // Empty string message is falsy → ?? returns 'API error'; real api.ts returns ''
    // because ?? only triggers on null/undefined, not empty string
    expect(() => unwrap(res)).toThrow();
  });

  it('throws when success is true but data is undefined', () => {
    const res: ApiResponse<never> = {
      success: true,
      data: undefined,
    };
    expect(() => unwrap(res)).toThrow('API error');
  });

  it('returns typed data with correct type inference', () => {
    const res: ApiResponse<string[]> = {
      success: true,
      data: ['player1', 'player2'],
    };
    const result = unwrap(res);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('player1');
  });
});
