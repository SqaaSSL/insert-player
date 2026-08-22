import { describe, expect, it } from 'vitest';
import { wranglerAuthIssue } from './wrangler-auth-status.mjs';

const accountId = '61fc998aa16c1c11a949d982e7a65dcb';

describe('Wrangler authentication readiness', () => {
  it('accepts a CI API token with access to the expected account', () => {
    expect(wranglerAuthIssue({
      status: 0,
      output: [
        'You are logged in with an User API Token.',
        'The API Token is read from the CLOUDFLARE_API_TOKEN environment variable.',
        `Admin account ${accountId}`,
      ].join('\n'),
      expectedAccountId: accountId,
    })).toBe('');
  });

  it('rejects a successful login to the wrong Cloudflare account', () => {
    expect(wranglerAuthIssue({
      status: 0,
      output: 'Account ID 00000000000000000000000000000000',
      expectedAccountId: accountId,
    })).toContain('does not list the expected Cloudflare account');
  });

  it('rejects explicit unauthenticated output', () => {
    expect(wranglerAuthIssue({
      status: 0,
      output: 'You are not authenticated. Please log in.',
      expectedAccountId: '',
    })).toContain('authentication is required');
  });

  it('rejects a failing whoami command', () => {
    expect(wranglerAuthIssue({
      status: 1,
      output: '',
      expectedAccountId: accountId,
    })).toBe('wrangler whoami exited with status 1');
  });
});
