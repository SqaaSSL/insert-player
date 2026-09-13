import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCasualApiClient, runCasualImportCli } from './import-casual-roster.mjs';
import { validateCasualDescriptor } from './package-casual-roster.mjs';

const FRONTEND = 'https://insertplayer.ai';
const ISSUER = 'https://clerk.insertplayer.ai';
const MAX_SESSION_MS = 15 * 60 * 1000;
const CLEANUP_RESERVE_MS = 3 * 60 * 1000;
const root = fileURLToPath(new URL('..', import.meta.url));

async function loadSessionRuntime() {
  const [{ createClerkClient }, { chromium }, helpers] = await Promise.all([
    import('@clerk/backend'), import('playwright'), import('./smoke-launch-auth.mjs'),
  ]);
  return { createClerkClient, chromium, ...helpers };
}

export async function runCasualImportWithSession(args, {
  env = process.env, runImport = runCasualImportCli, importOptions = {},
  readDescriptor = () => JSON.parse(readFileSync(resolve(root, 'arcade/casual-generated-v1.json'), 'utf8')),
  loadRuntime = loadSessionRuntime, now = Date.now,
  reportCleanup = value => process.stdout.write(`${JSON.stringify({ authentication: value })}\n`),
} = {}) {
  let clerk, browser, taskId, sessionId, runtime;
  let sessionStartedAt = 0;
  let cachedToken = '', tokenExpiresAt = 0;
  let failure, result, phase = 'import-preflight';
  const cleanup = { sessionEstablished: false, sessionRevoked: false,
    taskRevocation: 'not-created', cleanupUnknown: false, maxSessionSeconds: MAX_SESSION_MS / 1000 };

  const createClient = options => {
    let cleanupOperation = false;
    const remainingBudget = () => sessionStartedAt + MAX_SESSION_MS - now()
      - (cleanupOperation ? 35_000 : CLEANUP_RESERVE_MS);
    const assertBudget = () => assert.ok(remainingBudget() > 0,
      cleanupOperation ? 'Temporary session cleanup deadline reached.' : 'Import time budget reached; remaining session time is reserved for rollback.');
    const client = (importOptions.createClient ?? createCasualApiClient)({ ...options,
      fetchImpl: (url, init = {}) => {
        assertBudget();
        const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(
          remainingBudget(), cleanupOperation ? 60_000 : 120_000,
        ))));
        return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      },
    });
    // Includes anonymous downloads: verification cannot consume the rollback
    // reserve. Only a rollback-to-draft and exact cache purge may use it.
    return Object.fromEntries(Object.entries(client).map(([name, method]) => [name, async (...values) => {
      cleanupOperation = name === 'purgeArcadeCache' || (name === 'setArcade'
        && values[1]?.status === 'draft' && Object.keys(values[1]).length === 1);
      try { assertBudget(); return await method(...values); }
      finally { cleanupOperation = false; }
    }]));
  };

  // The original CLI validates every asset, confirmation, clean main checkout
  // and API origin before invoking this provider. A dry-run never invokes it.
  const createTokenProvider = async () => {
    phase = 'reviewed-descriptor';
    assert.ok(!clerk, 'Only one temporary import session is allowed.');
    assert.match(env.BUNDLE_ASSET ?? '', /^[a-z0-9][a-z0-9._-]{0,110}\.tar\.gz$/);
    assert.match(env.BUNDLE_SHA256 ?? '', /^[a-f0-9]{64}$/);
    const descriptor = validateCasualDescriptor(readDescriptor(), {
      assetName: env.BUNDLE_ASSET, archiveSha256: env.BUNDLE_SHA256,
    });
    const manifestSha = args.find(value => value.startsWith('--manifest-sha256='))?.slice('--manifest-sha256='.length);
    assert.equal(manifestSha, descriptor.bundle.manifestSha256, 'Manifest differs from committed Casual review.');
    phase = 'admin-account-pin';
    const userId = env.ASF_ARCADE_ADMIN_CLERK_USER_ID;
    assert.match(userId ?? '', /^user_[A-Za-z0-9_-]+$/);
    assert.equal(userId, env.ASF_LAUNCH_SMOKE_PRIMARY_USER_ID, 'Casual admin must match the independently pinned primary QA account.');
    phase = 'production-credentials';
    assert.ok(env.ASF_ARCADE_CLERK_SECRET_KEY?.startsWith('sk_live_'), 'Production Clerk credential required.');
    assert.ok(env.CLERK_BACKEND_AUTH_BRIDGE_SECRET?.length >= 32, 'Production backend bridge required.');
    assert.ok(env.CLOUDFLARE_API_TOKEN?.length >= 20 && /^[a-f0-9]{32}$/i.test(env.ASF_CLOUDFLARE_ZONE_ID ?? ''),
      'Production cache purge credentials required.');
    runtime = await loadRuntime();
    phase = 'admin-identity';
    clerk = runtime.createClerkClient({ secretKey: env.ASF_ARCADE_CLERK_SECRET_KEY });
    const user = await clerk.users.getUser(userId);
    assert.equal(user.id, userId, 'Clerk returned a different admin identity.');
    phase = 'admin-role';
    assert.equal(user.privateMetadata?.insert_player_role, 'admin', 'The pinned account must already be an admin.');
    phase = 'verified-oauth-qa';
    runtime.validateProductionQaUser(user, 'primary');
    phase = 'isolated-browser';
    browser = await runtime.chromium.launch({ headless: true });
    sessionStartedAt = now();
    phase = 'agent-task-bootstrap';
    const auth = await runtime.createAgentTaskBackedToken({
      clerk, browser, user, role: 'primary', frontendOrigin: FRONTEND, clerkIssuer: ISSUER,
      // No screenshots, trace, storage state, tokens or task URLs are artifacts.
      agentName: 'insert-player-casual-import', taskDescription: 'Import the sealed reviewed Casual roster',
      manageTaskCleanup: false,
      onTaskCreated: task => {
        cleanup.taskRevocation = 'pending';
        if (typeof task.agentTaskId !== 'string' || !task.agentTaskId) {
          cleanup.cleanupUnknown = true;
          throw new Error('Clerk did not return the created Agent Task identifier.');
        }
        taskId = task.agentTaskId;
      },
      onSessionCreated: identity => {
        assert.equal(identity.userId, userId, 'Isolated browser session belongs to another user.');
        assert.match(identity.sessionId ?? '', /^sess_[A-Za-z0-9_-]+$/);
        assert.ok(!sessionId || sessionId === identity.sessionId, 'Isolated import session changed.');
        sessionId = identity.sessionId; cleanup.sessionEstablished = true;
      },
    });
    phase = 'owned-session-token';
    assert.ok(sessionId && auth.sessionId === sessionId, 'Bootstrap did not return the observed owned session.');
    const acceptToken = token => {
      const checked = runtime.validateLaunchSmokeToken(token, { userId, frontendOrigin: FRONTEND,
        clerkIssuer: ISSUER, allowMissingAuthorizedParty: true, minRemainingSeconds: 30, nowMs: now() });
      assert.equal(checked.sessionId, sessionId, 'Token belongs to a different session.');
      cachedToken = token; tokenExpiresAt = Number(checked.claims.exp) * 1000;
      return token;
    };
    acceptToken(auth.token);
    await browser.close(); browser = null;
    phase = 'roster-import';
    return { userId, getToken: async () => {
      phase = 'owned-session-refresh';
      const remaining = sessionStartedAt + MAX_SESSION_MS - now();
      assert.ok(remaining > 35_000, 'Temporary import session reached its bounded lifetime.');
      if (tokenExpiresAt > now() + 30_000) { phase = 'roster-import'; return cachedToken; }
      const token = await clerk.sessions.getToken(sessionId, undefined, Math.min(600, Math.floor(remaining / 1000) - 5));
      const accepted = acceptToken(token.jwt);
      phase = 'roster-import';
      return accepted;
    } };
  };

  try {
    result = await runImport(args, { ...importOptions, env, createTokenProvider, createClient });
  } catch (error) {
    failure = error;
    if (phase === 'agent-task-bootstrap' && !taskId) {
      // The create response can be lost before its owned id is observable.
      cleanup.taskRevocation = 'unconfirmed'; cleanup.cleanupUnknown = true;
    }
  } finally {
    cachedToken = '';
    if (browser) await browser.close().catch(() => { cleanup.cleanupUnknown = true; });
    if (sessionId) {
      try {
        const revoked = await clerk.sessions.revokeSession(sessionId);
        assert.equal(revoked.id, sessionId); assert.equal(revoked.status, 'revoked');
        cleanup.sessionRevoked = true;
      } catch { cleanup.cleanupUnknown = true; }
    }
    if (taskId) {
      try {
        await clerk.agentTasks.revoke(taskId);
        cleanup.taskRevocation = 'revoked';
      } catch (error) {
        // https://clerk.com/docs/guides/development/errors/backend-api#agent_task_cannot_be_revoked
        // Clerk cannot revoke an already consumed ticket. Only a verified
        // owned-session revocation makes that expected outcome safe to accept.
        if (error?.status === 400 && error?.errors?.some(item => item.code === 'agent_task_cannot_be_revoked') && cleanup.sessionRevoked) {
          cleanup.taskRevocation = 'consumed-session-revoked';
        } else { cleanup.taskRevocation = 'unconfirmed'; cleanup.cleanupUnknown = true; }
      }
      if (!sessionId) cleanup.cleanupUnknown = true;
    }
    if (clerk) reportCleanup(cleanup);
  }
  if (cleanup.cleanupUnknown) throw new Error(`Casual import failed [${phase}]: temporary authentication cleanup is unconfirmed; no automatic retry. Any undiscovered session has a maximum 15-minute lifetime.`);
  if (failure) {
    const diagnostic = runtime?.formatSmokeError(failure) ?? 'Check the reviewed inputs and required production configuration.';
    throw new Error(`Casual import failed [${phase}]: ${diagnostic}`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCasualImportWithSession(process.argv.slice(2)).catch(error => {
    // Only the wrapper's phase and redacted diagnostics leave the process.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
