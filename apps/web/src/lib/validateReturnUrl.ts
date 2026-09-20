/**
 * Validates a return URL for safe redirect after login.
 * Only allows internal paths that start with `/` and are not protocol-relative.
 */
export function validateReturnUrl(returnUrl: string | null): string {
  if (!returnUrl) return '/kategorien';

  // Must start with a single slash
  if (!returnUrl.startsWith('/')) return '/kategorien';

  // Block protocol-relative URLs (e.g. //example.com)
  // The double-slash case is already caught above since '//' starts with '/',
  // but we still need to explicitly block it since '//example.com' starts with '/'
  if (returnUrl.startsWith('//')) return '/kategorien';

  // Block URL-encoded protocol-relative URLs (e.g. %2F%2Fexample.com → //example.com)
  try {
    const decoded = decodeURIComponent(returnUrl);
    if (decoded.startsWith('//')) return '/kategorien';
  } catch {
    // If decoding fails, treat as safe (not a protocol-relative encoded URL)
  }

  return returnUrl;
}
