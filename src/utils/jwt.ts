import crypto from 'node:crypto';

export interface JwtPayload {
  adminId: string;
  email: string;
  name?: string;
  role: string;
  assignedUnitId?: string | null;
  departmentId?: string | null;
  employeeId?: string | null;
  authTimeMs?: number;
  iat?: number;
  exp?: number;
}

function resolveJwtSecret(): string {
  const configuredSecret = process.env.JWT_SECRET;

  if (process.env.NODE_ENV === 'production' && (!configuredSecret || configuredSecret.length < 32)) {
    throw new Error(
      'FATAL: In production, JWT_SECRET must be explicitly set and be at least 32 characters long.'
    );
  }

  // Tests/development may use SESSION_SECRET for compatibility, or an
  // ephemeral process-local secret. No production credential is embedded in
  // the source tree.
  return configuredSecret || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
}

const JWT_SECRET = resolveJwtSecret();

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Signs a payload into a standard JWT Bearer token (HS256)
 * @param payload Claims to store in token
 * @param expiresInSeconds Lifetime in seconds (default: 7 days = 604800s)
 */
export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, expiresInSeconds: number = 7 * 24 * 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    authTimeMs: payload.authTimeMs ?? Date.now(),
    iat: now,
    exp: now + expiresInSeconds
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verifies a JWT Bearer token and returns the claims
 */
export function verifyJwt<T extends JwtPayload = JwtPayload>(token: string): { valid: boolean; payload?: T; error?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Empty token' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Malformed token structure' };
  }

  const [encodedHeader, encodedPayload, signature] = parts;

  // Compute expected signature
  const expectedSig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, error: 'Invalid token signature' };
  }

  try {
    const jsonStr = base64UrlDecode(encodedPayload);
    const payload = JSON.parse(jsonStr) as T;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Token has expired' };
    }

    return { valid: true, payload };
  } catch (err: any) {
    return { valid: false, error: `Failed to parse payload: ${err.message}` };
  }
}
