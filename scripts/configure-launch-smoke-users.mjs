import { createClerkClient } from '@clerk/backend';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  formatSmokeError,
  validateProductionQaUser,
} from './smoke-launch-auth.mjs';

const ALLOWED_OAUTH_PROVIDERS = new Set(['google', 'apple']);
const CONFIRMATION = 'CONFIGURE_PRODUCTION_LAUNCH_SMOKE_USERS';

function normalizedOauthProvider(provider) {
  return String(provider ?? '').toLowerCase().replace(/^oauth_/, '');
}

export function validateLaunchSmokeConfigurationUser(user, role, expectedAdminUserId) {
  if (!user || typeof user.id !== 'string' || !/^user_[A-Za-z0-9_-]+$/.test(user.id)) {
    throw new Error(`Production ${role} QA user could not be loaded from Clerk.`);
  }
  if (user.banned || user.locked) {
    throw new Error(`Production ${role} QA user is banned or locked.`);
  }
  const metadata = user.privateMetadata ?? {};
  if (role === 'primary' && user.id !== expectedAdminUserId) {
    throw new Error('Production primary QA user does not match the pinned Arcade admin Clerk user.');
  }
  if (role === 'clone' && (user.id === expectedAdminUserId || metadata.insert_player_role === 'admin')) {
    throw new Error('Production clone QA user must not have the Insert Player admin role.');
  }
  const verifiedProvider = (user.externalAccounts ?? []).find((account) => (
    ALLOWED_OAUTH_PROVIDERS.has(normalizedOauthProvider(account.provider))
    && account.verification?.status === 'verified'
  ));
  if (!verifiedProvider) {
    throw new Error(`Production ${role} QA user needs a verified Google or Apple OAuth account.`);
  }
  return normalizedOauthProvider(verifiedProvider.provider);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? '';
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  if (process.env.ASF_CONFIGURE_LAUNCH_SMOKE_CONFIRMATION !== CONFIRMATION) {
    throw new Error(`Set ASF_CONFIGURE_LAUNCH_SMOKE_CONFIRMATION=${CONFIRMATION} to continue.`);
  }
  const secretKey = requiredEnv('ASF_LAUNCH_SMOKE_CLERK_KEY');
  if (!secretKey.startsWith('sk_live_')) {
    throw new Error('ASF_LAUNCH_SMOKE_CLERK_KEY must belong to the Clerk Production instance.');
  }
  const primaryUserId = requiredEnv('ASF_LAUNCH_SMOKE_PRIMARY_USER_ID');
  const cloneUserId = requiredEnv('ASF_LAUNCH_SMOKE_CLONE_USER_ID');
  const adminUserId = requiredEnv('ASF_ARCADE_ADMIN_CLERK_USER_ID');
  if (primaryUserId === cloneUserId) {
    throw new Error('Production launch smoke needs two different Clerk users.');
  }

  const clerk = createClerkClient({ secretKey });
  const [primaryUser, cloneUser] = await Promise.all([
    clerk.users.getUser(primaryUserId),
    clerk.users.getUser(cloneUserId),
  ]);
  validateLaunchSmokeConfigurationUser(primaryUser, 'primary', adminUserId);
  validateLaunchSmokeConfigurationUser(cloneUser, 'clone', adminUserId);

  const [updatedPrimary, updatedClone] = await Promise.all([
    clerk.users.updateUserMetadata(primaryUserId, {
      privateMetadata: {
        insert_player_role: 'admin',
        insertPlayerLaunchSmokeQa: true,
        launchSmokeRole: 'primary',
      },
    }),
    clerk.users.updateUserMetadata(cloneUserId, {
      privateMetadata: {
        insertPlayerLaunchSmokeQa: true,
        launchSmokeRole: 'clone',
      },
    }),
  ]);
  validateProductionQaUser(updatedPrimary, 'primary');
  validateProductionQaUser(updatedClone, 'clone');
  if (updatedPrimary.privateMetadata?.insert_player_role !== 'admin') {
    throw new Error('Primary admin metadata was not preserved by the Clerk deep merge.');
  }
  console.log('Configured two verified production OAuth QA users without replacing existing private metadata.');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(formatSmokeError(error));
    process.exit(1);
  });
}
