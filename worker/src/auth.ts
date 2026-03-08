import type { Env, GoogleTokenResponse, GoogleUserInfo, User } from './types';

export function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashString(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const sessionId = generateId();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(sessionId, userId, expiresAt).run();

  return sessionId;
}

export async function validateSession(env: Env, sessionId: string): Promise<User | null> {
  const row = await env.DB.prepare(`
    SELECT u.* FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first<User>();

  return row ?? null;
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export function getSessionIdFromRequest(request: Request): string | null {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;
  const match = cookie.match(/session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

export function sessionCookie(sessionId: string, maxAge = 30 * 24 * 60 * 60): string {
  return `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  env: Env
): Promise<GoogleUserInfo> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${await tokenRes.text()}`);
  }

  const tokens: GoogleTokenResponse = await tokenRes.json();

  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    throw new Error(`Google userinfo failed: ${await userRes.text()}`);
  }

  return userRes.json();
}

export async function findOrCreateUser(
  env: Env,
  provider: string,
  oauthId: string,
  displayName: string,
  avatarUrl: string | null
): Promise<User> {
  const existing = await env.DB.prepare(
    'SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?'
  ).bind(provider, oauthId).first<User>();

  if (existing) {
    await env.DB.prepare(
      'UPDATE users SET display_name = ?, avatar_url = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(displayName, avatarUrl, existing.id).run();
    return { ...existing, display_name: displayName, avatar_url: avatarUrl };
  }

  const id = generateId();
  await env.DB.prepare(
    'INSERT INTO users (id, display_name, avatar_url, oauth_provider, oauth_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, displayName, avatarUrl, provider, oauthId).run();

  return (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>())!;
}
