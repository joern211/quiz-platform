// ============================================================
// Session Management
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

const COOKIE_NAME = 'quiz_session';

export function createSessionCookie(sessionId: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(sessionId).digest('base64url');
  const value = `${sessionId}.${signature}`;
  const maxAge = 7 * 24 * 60 * 60; // 7 days in seconds
  
  const NODE_ENV = process.env.NODE_ENV ?? 'development';
  const isProd = NODE_ENV === 'production';

  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${isProd ? 'Strict' : 'Lax'}`,
    `Secure=${isProd ? 'true' : 'false'}`,
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function verifySession(req: Request, secret: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [key, ...vals] = c.trim().split('=');
      return [key, vals.join('=')];
    })
  );

  const sessionCookie = cookies[COOKIE_NAME];
  if (!sessionCookie) return null;

  const [sessionId, signature] = sessionCookie.split('.');
  if (!sessionId || !signature) return null;

  // Verify signature
  const expectedSignature = createHmac('sha256', secret).update(sessionId).digest('base64url');
  
  try {
    const sigBuffer = Buffer.from(signature, 'base64url');
    const expectedBuffer = Buffer.from(expectedSignature, 'base64url');
    
    if (sigBuffer.length !== expectedBuffer.length) return null;
    if (!timingSafeEqual(sigBuffer, expectedBuffer)) return null;
    
    return sessionId;
  } catch {
    return null;
  }
}

export function deleteSessionCookie(res: Response): void {
  const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${isProd ? 'Strict' : 'Lax'}`,
    `Secure=${isProd ? 'true' : 'false'}`,
    'Max-Age=0',
  ].join('; '));
}
