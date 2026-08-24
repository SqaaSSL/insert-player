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

describe('production launch-smoke user configuration guard', () => {
  it('accepts an existing admin primary and non-admin OAuth clone', () => {
    expect(validateLaunchSmokeConfigurationUser(oauthUser('primary'), 'primary')).toBe('google');
    expect(validateLaunchSmokeConfigurationUser(oauthUser('clone'), 'clone')).toBe('google');
  });

  it('never invents the admin role or assigns an admin as clone', () => {
    expect(() => validateLaunchSmokeConfigurationUser({
      ...oauthUser('primary'),
      privateMetadata: {},
    }, 'primary')).toThrow(/already have insert_player_role=admin/i);
    expect(() => validateLaunchSmokeConfigurationUser({
      ...oauthUser('clone'),
      privateMetadata: { insert_player_role: 'admin' },
    }, 'clone')).toThrow(/must not have.*admin role/i);
  });

  it('rejects locked and non-OAuth users before any metadata write', () => {
    expect(() => validateLaunchSmokeConfigurationUser({
      ...oauthUser('primary'),
      locked: true,
    }, 'primary')).toThrow(/banned or locked/i);
    expect(() => validateLaunchSmokeConfigurationUser({
      ...oauthUser('clone'),
      externalAccounts: [{ provider: 'oauth_google', verification: { status: 'unverified' } }],
    }, 'clone')).toThrow(/verified Google or Apple/i);
  });
});
