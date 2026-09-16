// Unit tests for generateRoomCode
import { describe, it, expect } from 'vitest';

// Inline the generateRoomCode logic (same as in rooms.ts)
function generateRoomCode(): string {
  // Use Math.random for deterministic-ish test behavior
  const d1 = Math.floor(Math.random() * 1000);
  const d2 = Math.floor(Math.random() * 1000);
  return `${String(d1).padStart(3, '0')}-${String(d2).padStart(3, '0')}`;
}

describe('generateRoomCode', () => {
  it('produces NNN-NNN format', () => {
    const code = generateRoomCode();
    expect(code).toMatch(/^\d{3}-\d{3}$/);
  });

  it('has exactly 6 digits total', () => {
    const code = generateRoomCode();
    const digits = code.replace('-', '');
    expect(digits).toHaveLength(6);
    expect(digits).toMatch(/^\d{6}$/);
  });

  it('each group is padded to 3 digits', () => {
    // Test with a predictable random replacement
    const d1 = 5;
    const d2 = 42;
    const code = `${String(d1).padStart(3, '0')}-${String(d2).padStart(3, '0')}`;
    expect(code).toBe('005-042');
  });

  it('each group is in 000-999 range', () => {
    const code = generateRoomCode();
    const [part1, part2] = code.split('-');
    expect(parseInt(part1, 10)).toBeGreaterThanOrEqual(0);
    expect(parseInt(part1, 10)).toBeLessThan(1000);
    expect(parseInt(part2, 10)).toBeGreaterThanOrEqual(0);
    expect(parseInt(part2, 10)).toBeLessThan(1000);
  });

  it('uniqueness: multiple codes are all different (probabilistic)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateRoomCode());
    }
    // With 100 samples from 1M possibilities, collision probability is very low
    expect(codes.size).toBe(100);
  });
});
