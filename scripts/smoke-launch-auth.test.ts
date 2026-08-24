import { describe, expect, it } from 'vitest';
import {
  buildSmokeUserParams,
  decodeJwtPayload,
  formatSmokeError,
  redactSmokeDiagnostic,
  validateLaunchSmokeToken,
} from './smoke-launch-auth.mjs';

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

describe('automated Clerk launch-smoke user creation', () => {
  it('creates a social-only technical user without disabled identifiers', () => {
    const params = buildSmokeUserParams('run-123', 'primary');
    expect(params).toEqual({
      externalId: 'insert-player-launch-smoke:run-123:primary',
      privateMetadata: {
        insertPlayerLaunchSmoke: true,
        launchSmokeRunId: 'run-123',
        launchSmokeRole: 'primary',
      },
    });
    expect(params).not.toHaveProperty('emailAddress');
    expect(params).not.toHaveProperty('password');
    expect(params).not.toHaveProperty('skipLegalChecks');
  });

  it('reports actionable Clerk codes while redacting sensitive values', () => {
    const diagnostic = formatSmokeError({
      status: 422,
      clerkTraceId: 'trace_safe123',
      errors: [{
        code: 'form_param_value_invalid',
        message: 'Invalid identifier',
        longMessage: 'Rejected person@example.com for user_secret123; see https://clerk.example/tasks/task_secret456?ticket=abc',
      }],
    });
    expect(diagnostic).toContain('Clerk API HTTP 422');
    expect(diagnostic).toContain('form_param_value_invalid');
    expect(diagnostic).toContain('trace_safe123');
    expect(diagnostic).not.toContain('person@example.com');
    expect(diagnostic).not.toContain('user_secret123');
    expect(diagnostic).not.toContain('https://');
    expect(diagnostic).not.toContain('task_secret456');
  });

  it('redacts API keys, bearer tokens, JWTs, and multiline output', () => {
    const diagnostic = redactSmokeDiagnostic([
      'sk_live_secret123',
      'Bearer opaque.token-value',
      'eyJheader.eyJpayload.signature',
      'second@example.com',
    ].join('\n'));
    expect(diagnostic).toBe(
      '[redacted-api-key] Bearer [redacted-token] [redacted-jwt] [redacted-email]',
    );
  });
});
