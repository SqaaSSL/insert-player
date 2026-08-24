import { describe, expect, it } from 'vitest';
import { validateLaunchSmokeConfigurationUser } from './configure-launch-smoke-users.mjs';

function oauthUser(role: 'primary' | 'clone') {
  return {
    id: `user_${role}`,
    banned: false,
    locked: false,
    privateMetadata: role === 'primary' ? { insert_player_role: 'admin' } : {},
    externalAccounts: [{
      provider: 'oauth_google',
      verification: { status: 'verified' },
    }],
  };
}

const adminUserId = 'user_primary';

describe('production launch-smoke user configuration guard', () => {
  it('accepts an existing admin primary and non-admin OAuth clone', () => {
    expect(validateLaunchSmokeConfigurationUser(oauthUser('primary'), 'primary', adminUserId)).toBe('google');
    expect(validateLaunchSmokeConfigurationUser(oauthUser('clone'), 'clone', adminUserId)).toBe('google');
  });

  it('pins primary admin restoration to the separate Arcade admin secret', () => {
    expect(() => validateLaunchSmokeConfigurationUser({
      ...oauthUser('primary'),
      privateMetadata: {},
    }, 'primary', 'user_someone_else')).toThrow(/pinned Arcade admin/i);
    expect(validateLaunchSmokeConfigurationUser({
      ...oauthUser('primary'),
      privateMetadata: {},
    }, 'primary', adminUserId)).toBe('google');
    expect(() => validateLaunchSmokeConfigurationUser({
      ...oauthUser('clone'),
      privateMetadata: { insert_player_role: 'admin' },
    }, 'clone', adminUserId)).toThrow(/must not have.*admin role/i);
  });

  it('rejects locked and non-OAuth users before any metadata write', () => {
    expect(() => validateLaunchSmokeConfigurationUser({
      ...oauthUser('primary'),
      locked: true,
    }, 'primary', adminUserId)).toThrow(/banned or locked/i);
    expect(() => validateLaunchSmokeConfigurationUser({
      ...oauthUser('clone'),
      externalAccounts: [{ provider: 'oauth_google', verification: { status: 'unverified' } }],
    }, 'clone', adminUserId)).toThrow(/verified Google or Apple/i);
  });
});
