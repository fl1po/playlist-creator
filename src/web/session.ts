import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const COOKIE_NAME = 'sp_session';
const MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

function sign(userId: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret).update(userId).digest('hex');
  return `${userId}.${hmac}`;
}

function verify(value: string, secret: string): string | null {
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const userId = value.slice(0, dot);
  const expected = sign(userId, secret);
  if (value.length !== expected.length) return null;
  // Timing-safe comparison
  if (!crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected)))
    return null;
  return userId;
}

export function setSessionCookie(
  res: ServerResponse,
  userId: string,
  secret: string,
): void {
  const value = sign(userId, secret);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

export function getSessionUserId(
  req: IncomingMessage,
  secret: string,
): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      return verify(rest.join('='), secret);
    }
  }
  return null;
}

/**
 * Extract Bearer token from Authorization header.
 * Returns the raw access token or null.
 */
export function getBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

/**
 * Extract refresh token from X-Refresh-Token header.
 * Sent by the client on every Bearer-auth request so the server can rebuild
 * its in-memory session after a restart, regardless of HTTP method.
 */
export function getRefreshToken(req: IncomingMessage): string | null {
  const value = req.headers['x-refresh-token'];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}
