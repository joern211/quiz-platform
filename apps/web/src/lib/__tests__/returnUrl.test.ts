import { describe, it, expect } from 'vitest';
import { validateReturnUrl } from '../validateReturnUrl';

describe('validateReturnUrl', () => {
  describe('null / undefined inputs', () => {
    it('returns /kategorien for null', () => {
      expect(validateReturnUrl(null)).toBe('/kategorien');
    });

    it('returns /kategorien for undefined', () => {
      expect(validateReturnUrl(undefined as unknown as null)).toBe('/kategorien');
    });
  });

  describe('empty / whitespace', () => {
    it('returns /kategorien for empty string', () => {
      expect(validateReturnUrl('')).toBe('/kategorien');
    });
  });

  describe('external URLs', () => {
    it('returns /kategorien for https:// URLs', () => {
      expect(validateReturnUrl('https://example.com')).toBe('/kategorien');
    });

    it('returns /kategorien for http:// URLs', () => {
      expect(validateReturnUrl('http://example.com')).toBe('/kategorien');
    });
  });

  describe('protocol-relative URLs', () => {
    it('returns /kategorien for protocol-relative // URL', () => {
      expect(validateReturnUrl('//example.com')).toBe('/kategorien');
    });

    it('returns /kategorien for URL-encoded protocol-relative // URL', () => {
      expect(validateReturnUrl('%2F%2Fexample.com')).toBe('/kategorien');
    });

    it('returns /kategorien for URL-encoded protocol-relative // with path', () => {
      expect(validateReturnUrl('%2F%2Fexample.com/evil')).toBe('/kategorien');
    });
  });

  describe('paths not starting with /', () => {
    it('returns /kategorien for relative paths', () => {
      expect(validateReturnUrl('moderator/vorbereitung/geo')).toBe('/kategorien');
    });

    it('returns /kategorien for plain domain-like strings', () => {
      expect(validateReturnUrl('example.com')).toBe('/kategorien');
    });
  });

  describe('valid internal paths', () => {
    it('returns the path as-is for /kategorien', () => {
      expect(validateReturnUrl('/kategorien')).toBe('/kategorien');
    });

    it('returns the path as-is for a nested internal path', () => {
      expect(validateReturnUrl('/moderator/vorbereitung/geo')).toBe(
        '/moderator/vorbereitung/geo',
      );
    });

    it('returns the path as-is for root path', () => {
      expect(validateReturnUrl('/')).toBe('/');
    });

    it('returns the path as-is for a deeply nested path', () => {
      expect(validateReturnUrl('/a/b/c/d')).toBe('/a/b/c/d');
    });
  });
});
