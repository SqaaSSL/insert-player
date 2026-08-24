import { describe, expect, it } from 'vitest';
import { decodeJwtPayload, validateLaunchSmokeToken } from './smoke-launch-auth.mjs';

function tokenWith(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

const nowMs = Date.UTC(2026, 7, 24, 2, 0, 0);
const validPayload = {
  sub: 'user_primary',
  sid: 'sess_launch_smoke',
  azp: 'https://insertplayer.ai',
  iss: 'https://clerk.insertplayer.ai',
  exp: Math.floor(nowMs / 1000) + 600,
};

describe('automated Clerk launch-smoke token guard', () => {
  it('accepts a live token bound to the production user, issuer, and frontend', () => {
    const token = tokenWith(validPayload);
    expect(decodeJwtPayload(token)).toEqual(validPayload);
    expect(validateLaunchSmokeToken(token, {
      userId: 'user_primary',
      frontendOrigin: 'https://insertplayer.ai',
      clerkIssuer: 'https://clerk.insertplayer.ai',
      minRemainingSeconds: 480,
      nowMs,
    }).sessionId).toBe('sess_launch_smoke');
  });

  it('fails closed for tokens from a different user or browser origin', () => {
    expect(() => validateLaunchSmokeToken(tokenWith(validPayload), {
      userId: 'user_clone',
      frontendOrigin: 'https://insertplayer.ai',
      clerkIssuer: 'https://clerk.insertplayer.ai',
      nowMs,
    })).toThrow(/different user/i);
    expect(() => validateLaunchSmokeToken(tokenWith({
      ...validPayload,
      azp: 'https://evil.example',
    }), {
      userId: 'user_primary',
      frontendOrigin: 'https://insertplayer.ai',
      clerkIssuer: 'https://clerk.insertplayer.ai',
      nowMs,
    })).toThrow(/authorized party/i);
  });

  it('rejects wrong issuers, missing sessions, and short-lived tokens', () => {
    expect(() => validateLaunchSmokeToken(tokenWith({
      ...validPayload,
      iss: 'https://another.clerk.accounts.dev',
    }), {
      userId: 'user_primary',
      frontendOrigin: 'https://insertplayer.ai',
      clerkIssuer: 'https://clerk.insertplayer.ai',
      nowMs,
    })).toThrow(/wrong issuer/i);
    expect(() => validateLaunchSmokeToken(tokenWith({ ...validPayload, sid: '' }), {
      userId: 'user_primary',
      frontendOrigin: 'https://insertplayer.ai',
      clerkIssuer: 'https://clerk.insertplayer.ai',
      nowMs,
    })).toThrow(/session id/i);
    expect(() => validateLaunchSmokeToken(tokenWith({
      ...validPayload,
      exp: Math.floor(nowMs / 1000) + 30,
    }), {
      userId: 'user_primary',
      frontendOrigin: 'https://insertplayer.ai',
      clerkIssuer: 'https://clerk.insertplayer.ai',
      minRemainingSeconds: 60,
      nowMs,
    })).toThrow(/expires too soon/i);
  });
});
