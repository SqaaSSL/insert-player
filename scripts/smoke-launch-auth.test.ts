import { describe, expect, it } from 'vitest';
import {
  buildSandboxSmokeUserParams,
  decodeJwtPayload,
  formatSmokeError,
  parseSmokeTarget,
  redactSmokeDiagnostic,
  validateLaunchSmokeToken,
  validateProductionQaUser,
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

describe('automated Clerk launch-smoke targets', () => {
  it('selects only the pinned production and sandbox targets', () => {
    expect(parseSmokeTarget([])).toBe('production');
    expect(parseSmokeTarget(['--target=production'])).toBe('production');
    expect(parseSmokeTarget(['--target=sandbox'])).toBe('sandbox');
    expect(() => parseSmokeTarget(['--target=preview'])).toThrow(/production or --target=sandbox/i);
    expect(() => parseSmokeTarget(['--target=sandbox', '--target=production'])).toThrow(/exactly one/i);
  });

  it('creates identified, disposable sandbox users with Clerk test addresses', () => {
    const params = buildSandboxSmokeUserParams('run-123', 'primary');
    expect(params).toEqual({
      externalId: 'insert-player-launch-smoke:run-123:primary',
      emailAddress: ['insert-player+clerk_test_run-123_primary@example.com'],
      firstName: 'Launch Smoke',
      lastName: 'Primary',
      skipPasswordRequirement: true,
      skipLegalChecks: true,
      privateMetadata: {
        insertPlayerLaunchSmoke: true,
        launchSmokeRunId: 'run-123',
        launchSmokeRole: 'primary',
      },
    });
    expect(params).not.toHaveProperty('password');
    expect(params).not.toHaveProperty('legalAcceptedAt');
  });

  it('accepts only explicitly marked, verified production OAuth QA users', () => {
    const user = {
      id: 'user_primary',
      banned: false,
      locked: false,
      privateMetadata: {
        insertPlayerLaunchSmokeQa: true,
        launchSmokeRole: 'primary',
      },
      externalAccounts: [{
        provider: 'oauth_google',
        verification: { status: 'verified' },
      }],
    };
    expect(validateProductionQaUser(user, 'primary')).toBe('google');
    expect(() => validateProductionQaUser({
      ...user,
      privateMetadata: { ...user.privateMetadata, launchSmokeRole: 'clone' },
    }, 'primary')).toThrow(/private metadata/i);
    expect(() => validateProductionQaUser({
      ...user,
      externalAccounts: [{ provider: 'google', verification: { status: 'unverified' } }],
    }, 'primary')).toThrow(/verified Google or Apple/i);
    expect(() => validateProductionQaUser({ ...user, locked: true }, 'primary')).toThrow(/banned or locked/i);
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
