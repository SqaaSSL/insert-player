import { describe, expect, it } from 'vitest';
import {
  INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
  clerkPublishableKeyIssues,
  decodeClerkPublishableKey,
} from './clerk-publishable-key.mjs';

function publishableKey(environment: 'test' | 'live', host: string): string {
  return `pk_${environment}_${Buffer.from(`${host}$`).toString('base64url')}`;
}

describe('Clerk publishable key validation', () => {
  it('decodes the environment and Frontend API host', () => {
    expect(decodeClerkPublishableKey(publishableKey('live', INSERT_PLAYER_CLERK_FRONTEND_API_HOST))).toEqual({
      environment: 'live',
      frontendApiHost: INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
      frontendApiOrigin: `https://${INSERT_PLAYER_CLERK_FRONTEND_API_HOST}`,
    });
  });

  it('rejects a live key for a different Clerk application domain', () => {
    expect(clerkPublishableKeyIssues(publishableKey('live', 'clerk.shellbot.sh'), {
      expectedEnvironment: 'live',
      expectedFrontendApiHost: INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
    })).toEqual(['Frontend API must be clerk.insertplayer.ai']);
  });

  it('rejects development keys on the production path', () => {
    expect(clerkPublishableKeyIssues(publishableKey('test', 'right-cricket-1317.clerk.accounts.dev'), {
      expectedEnvironment: 'live',
      expectedFrontendApiHost: INSERT_PLAYER_CLERK_FRONTEND_API_HOST,
    })).toEqual([
      'environment must be live',
      'Frontend API must be clerk.insertplayer.ai',
    ]);
  });

  it('rejects malformed or path-bearing payloads', () => {
    expect(decodeClerkPublishableKey('pk_live_not-base64')).toBeNull();
    expect(decodeClerkPublishableKey(publishableKey('live', 'clerk.insertplayer.ai/path'))).toBeNull();
  });
});
