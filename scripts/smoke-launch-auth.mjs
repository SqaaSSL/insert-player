import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClerkClient } from '@clerk/backend';
import { isClerkAPIResponseError } from '@clerk/backend/errors';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const TOKEN_TTL_SECONDS = 10 * 60;
const BROWSER_TIMEOUT_MS = 90_000;
const TOMBSTONE_TIMEOUT_MS = 90_000;
const LIVE_SMOKE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DIAGNOSTIC_LENGTH = 1_200;
const PRODUCTION_QA_MARKER = 'insertPlayerLaunchSmokeQa';
const PRODUCTION_QA_ROLE = 'launchSmokeRole';
const ALLOWED_QA_OAUTH_PROVIDERS = new Set(['apple', 'google']);

const TARGET_CONFIG = {
  production: {
    expectedFrontendOrigin: 'https://insertplayer.ai',
    expectedWorkerUrl: 'https://api.insertplayer.ai',
    expectedClerkIssuer: 'https://clerk.insertplayer.ai',
    secretPrefix: 'sk_live_',
    preserveUserState: true,
  },
  sandbox: {
    expectedFrontendOrigin: 'https://insert-player-sandbox.pages.dev',
    expectedWorkerUrl: 'https://insert-player-api-sandbox.shellbot.workers.dev',
    expectedClerkIssuer: 'https://right-cricket-1317.clerk.accounts.dev',
    secretPrefix: 'sk_test_',
    preserveUserState: false,
  },
};

export function parseSmokeTarget(argv) {
  const values = argv
    .filter((arg) => arg.startsWith('--target='))
    .map((arg) => arg.slice('--target='.length).trim());
  if (values.length > 1) throw new Error('Pass exactly one launch-smoke target.');
  const target = values[0] || 'production';
  if (!Object.hasOwn(TARGET_CONFIG, target)) {
    throw new Error('Launch-smoke target must be --target=production or --target=sandbox.');
  }
  return target;
}

export function redactSmokeDiagnostic(value) {
  return String(value ?? '')
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b/g, '[redacted-api-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted-token]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(?:user|sess|session|agent_task|task)_[A-Za-z0-9_-]+\b/gi, '[redacted-id]')
    .replace(/https?:\/\/[^\s<>()]+/gi, '[redacted-url]')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function hasClerkApiErrorShape(error) {
  return Boolean(
    error
    && typeof error === 'object'
    && Number.isInteger(error.status)
    && Array.isArray(error.errors),
  );
}

export function formatSmokeError(error) {
  if (isClerkAPIResponseError(error) || hasClerkApiErrorShape(error)) {
    const details = error.errors
      .map((entry) => {
        const code = typeof entry?.code === 'string' ? entry.code : 'unknown_error';
        const message = entry?.longMessage || entry?.message || 'No Clerk error detail was returned.';
        return `${code}: ${message}`;
      })
      .join('; ');
    const trace = typeof error.clerkTraceId === 'string' && error.clerkTraceId
      ? ` (Clerk trace ${error.clerkTraceId})`
      : '';
    return redactSmokeDiagnostic(`Clerk API HTTP ${error.status}: ${details}${trace}`);
  }
  if (error instanceof Error) return redactSmokeDiagnostic(error.message);
  return redactSmokeDiagnostic(error);
}

function parseEnvText(text, values) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value && !values.has(key)) values.set(key, value);
  }
}

function readEnvValues(target) {
  const values = new Map();
  const files = target === 'sandbox'
    ? ['.env.sandbox.local', '.env.sandbox', '.env.local', '.env']
    : ['.env.production.local', '.env.production', '.env.local', '.env'];
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path)) parseEnvText(readFileSync(path, 'utf8'), values);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function envValue(values, key) {
  return values.get(key)?.trim() ?? '';
}

function normalizedOrigin(value) {
  return value.trim().replace(/\/+$/, '');
}

export function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Clerk launch-smoke token is not a JWT.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Clerk launch-smoke token payload could not be decoded.');
  }
}

export function validateLaunchSmokeToken(token, {
  userId,
  frontendOrigin,
  clerkIssuer,
  allowMissingAuthorizedParty = false,
  minRemainingSeconds = 10,
  nowMs = Date.now(),
}) {
  const claims = decodeJwtPayload(token);
  if (claims.sub !== userId) throw new Error('Clerk launch-smoke token belongs to a different user.');
  const authorizedParty = normalizedOrigin(String(claims.azp ?? ''));
  if (!authorizedParty && !allowMissingAuthorizedParty) {
    throw new Error('Clerk launch-smoke token is missing its authorized-party claim.');
  }
  if (authorizedParty && authorizedParty !== normalizedOrigin(frontendOrigin)) {
    let receivedHost = 'invalid-origin';
    try {
      receivedHost = new URL(authorizedParty).hostname || receivedHost;
    } catch {
      // Keep malformed claims out of diagnostics while still failing closed.
    }
    throw new Error(`Clerk launch-smoke token has an unexpected authorized-party host (${receivedHost}).`);
  }
  if (normalizedOrigin(String(claims.iss ?? '')) !== normalizedOrigin(clerkIssuer)) {
    throw new Error('Clerk launch-smoke token has the wrong issuer.');
  }
  if (typeof claims.sid !== 'string' || !claims.sid.trim()) {
    throw new Error('Clerk launch-smoke token is missing a session id.');
  }
  const expiresAt = Number(claims.exp ?? 0) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt < nowMs + minRemainingSeconds * 1000) {
    throw new Error('Clerk launch-smoke token expires too soon.');
  }
  return { claims, sessionId: claims.sid };
}

export async function forceFreshBrowserClerkToken() {
  const clerk = globalThis.Clerk;
  if (!clerk?.session?.getToken) {
    throw new Error('The frontend Clerk session was not available after Agent Task bootstrap.');
  }
  const token = await clerk.session.getToken({ skipCache: true });
  if (!token) {
    throw new Error('Clerk did not mint a fresh frontend session token.');
  }
  return token;
}

function normalizedOauthProvider(provider) {
  return String(provider ?? '').toLowerCase().replace(/^oauth_/, '');
}

export function validateProductionQaUser(user, role) {
  if (!user || typeof user.id !== 'string') {
    throw new Error(`Production ${role} QA user could not be loaded from Clerk.`);
  }
  if (user.banned || user.locked) {
    throw new Error(`Production ${role} QA user is banned or locked.`);
  }
  const metadata = user.privateMetadata ?? {};
  if (metadata[PRODUCTION_QA_MARKER] !== true || metadata[PRODUCTION_QA_ROLE] !== role) {
    throw new Error(
      `Production ${role} user must be explicitly marked in Clerk private metadata as ${PRODUCTION_QA_MARKER}=true and ${PRODUCTION_QA_ROLE}=${role}.`,
    );
  }
  const verifiedProvider = (user.externalAccounts ?? []).find((account) => (
    ALLOWED_QA_OAUTH_PROVIDERS.has(normalizedOauthProvider(account.provider))
    && account.verification?.status === 'verified'
  ));
  if (!verifiedProvider) {
    throw new Error(`Production ${role} QA user needs a verified Google or Apple OAuth account.`);
  }
  return normalizedOauthProvider(verifiedProvider.provider);
}

export function buildSandboxSmokeUserParams(runId, role) {
  return {
    externalId: `insert-player-launch-smoke:${runId}:${role}`,
    emailAddress: [`insert-player+clerk_test_${runId}_${role}@example.com`],
    firstName: 'Launch Smoke',
    lastName: role === 'primary' ? 'Primary' : 'Clone',
    skipPasswordRequirement: true,
    skipLegalChecks: true,
    privateMetadata: {
      insertPlayerLaunchSmoke: true,
      launchSmokeRunId: runId,
      launchSmokeRole: role,
    },
  };
}

async function captureFrontendSessionToken({
  browser,
  agentTaskUrl,
  frontendOrigin,
  role,
  artifactDir,
}) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const response = await page.goto(agentTaskUrl, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_TIMEOUT_MS,
    });
    if (response && !response.ok()) {
      throw new Error(`Clerk Agent Task bootstrap failed with HTTP ${response.status()}.`);
    }
    await page.waitForURL((candidate) => (
      candidate.origin === frontendOrigin && candidate.pathname === '/menu'
    ), { timeout: BROWSER_TIMEOUT_MS });
    await page.waitForFunction(
      () => Boolean(globalThis.Clerk?.loaded && globalThis.Clerk?.session),
      undefined,
      { timeout: BROWSER_TIMEOUT_MS },
    );
    return await page.evaluate(forceFreshBrowserClerkToken);
  } catch (error) {
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({ path: join(artifactDir, `${role}-failure.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    await context.close();
  }
}

function launchSmokeRunId() {
  const candidate = [
    process.env.GITHUB_RUN_ID,
    process.env.GITHUB_RUN_ATTEMPT,
    Date.now(),
  ].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return candidate.slice(0, 80);
}

async function createSandboxSmokeUser(clerk, runId, role) {
  try {
    return await clerk.users.createUser(buildSandboxSmokeUserParams(runId, role));
  } catch (error) {
    throw new Error(`Could not create the ephemeral ${role} Clerk user: ${formatSmokeError(error)}`);
  }
}

async function loadProductionQaUsers(clerk, primaryUserId, cloneUserId) {
  if (!/^user_[A-Za-z0-9_-]+$/.test(primaryUserId) || !/^user_[A-Za-z0-9_-]+$/.test(cloneUserId)) {
    throw new Error(
      'Production launch smoke needs ASF_LAUNCH_SMOKE_PRIMARY_USER_ID and ASF_LAUNCH_SMOKE_CLONE_USER_ID from two dedicated OAuth QA accounts.',
    );
  }
  if (primaryUserId === cloneUserId) {
    throw new Error('Production launch smoke needs two different dedicated OAuth QA users.');
  }
  const [primaryUser, cloneUser] = await Promise.all([
    clerk.users.getUser(primaryUserId),
    clerk.users.getUser(cloneUserId),
  ]);
  validateProductionQaUser(primaryUser, 'primary');
  validateProductionQaUser(cloneUser, 'clone');
  return { primaryUser, cloneUser };
}

async function createAgentTaskBackedToken({
  clerk,
  browser,
  user,
  role,
  frontendOrigin,
  clerkIssuer,
  artifactDir,
}) {
  let task = null;
  let consumed = false;
  try {
    task = await clerk.agentTasks.create({
      onBehalfOf: { userId: user.id },
      permissions: '*',
      agentName: 'insert-player-launch-smoke',
      taskDescription: `Insert Player launch smoke (${role})`,
      redirectUrl: `${frontendOrigin}/menu`,
      sessionMaxDurationInSeconds: 15 * 60,
    });
    const shortToken = await captureFrontendSessionToken({
      browser,
      agentTaskUrl: task.url,
      frontendOrigin,
      role,
      artifactDir,
    });
    consumed = true;
    const { sessionId } = validateLaunchSmokeToken(shortToken, {
      userId: user.id,
      frontendOrigin,
      clerkIssuer,
      allowMissingAuthorizedParty: true,
    });
    const refreshed = await clerk.sessions.getToken(sessionId, undefined, TOKEN_TTL_SECONDS);
    validateLaunchSmokeToken(refreshed.jwt, {
      userId: user.id,
      frontendOrigin,
      clerkIssuer,
      allowMissingAuthorizedParty: true,
      minRemainingSeconds: 8 * 60,
    });
    return { token: refreshed.jwt, sessionId };
  } catch (error) {
    throw new Error(`Could not establish the ${role} Agent Task session: ${formatSmokeError(error)}`);
  } finally {
    if (task && !consumed) {
      await clerk.agentTasks.revoke(task.agentTaskId).catch((revokeError) => {
        console.error(`Could not revoke the unused ${role} Agent Task: ${formatSmokeError(revokeError)}`);
      });
    }
  }
}

function runAuthenticatedLiveSmoke(primaryToken, cloneToken, target, preserveUserState, backendAuthBridgeSecret) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/smoke-live.mjs'), '--require-auth', '--require-clone'],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        ASF_CLERK_JWT: primaryToken,
        ASF_CLERK_JWT_CLONE: cloneToken,
        ASF_SMOKE_REQUIRE_AUTH: '1',
        ASF_SMOKE_REQUIRE_CLONE: '1',
        ASF_SMOKE_TARGET: target,
        ASF_SMOKE_PRESERVE_USER_STATE: preserveUserState ? '1' : '0',
        CLERK_BACKEND_AUTH_BRIDGE_SECRET: backendAuthBridgeSecret,
      },
      timeout: LIVE_SMOKE_TIMEOUT_MS,
    },
  );
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error('Authenticated launch smoke timed out after 10 minutes.');
    }
    throw result.error;
  }
  if (result.signal) throw new Error(`Authenticated launch smoke exited with signal ${result.signal}.`);
  if (result.status !== 0) {
    throw new Error(`Authenticated launch smoke failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function authMeRejectsDeletedIdentity(status, body) {
  return status === 401 || (status === 200 && body?.user === null);
}

async function waitForDeletedTokenRejection({ token, workerUrl, frontendOrigin, role }) {
  const started = Date.now();
  let lastStatus = 0;
  while (Date.now() - started <= TOMBSTONE_TIMEOUT_MS) {
    const response = await fetch(`${workerUrl}/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: frontendOrigin,
      },
      signal: AbortSignal.timeout(15_000),
    });
    lastStatus = response.status;
    const body = response.status === 200
      ? await response.json().catch(() => null)
      : null;
    if (authMeRejectsDeletedIdentity(response.status, body)) {
      if (response.body) await response.body.cancel().catch(() => {});
      console.log(`\u2713 ${role} Clerk deletion tombstones its still-valid session token`);
      return;
    }
    if (response.body) await response.body.cancel().catch(() => {});
    await sleep(2_000);
  }
  throw new Error(`${role} deleted Clerk token remained usable (last HTTP ${lastStatus || 'unknown'}).`);
}

async function deleteSandboxSmokeUser(clerk, user, role) {
  if (!user?.id) return false;
  await clerk.users.deleteUser(user.id);
  console.log(`\u2713 deleted ephemeral ${role} Clerk user`);
  return true;
}

async function revokeProductionQaSession(clerk, sessionId, role) {
  if (!sessionId) return;
  const session = await clerk.sessions.revokeSession(sessionId);
  if (session.status !== 'revoked') {
    throw new Error(`Production ${role} QA session did not reach revoked status.`);
  }
  console.log(`\u2713 revoked production ${role} QA session`);
}

function validateTargetConfiguration(target, env) {
  const config = TARGET_CONFIG[target];
  const secretKey = envValue(env, 'ASF_LAUNCH_SMOKE_CLERK_KEY');
  const frontendOrigin = normalizedOrigin(
    envValue(env, 'ASF_FRONTEND_ORIGIN')
      || envValue(env, 'ASF_FRONTEND_URL')
      || (target === 'sandbox' ? envValue(env, 'ASF_SANDBOX_FRONTEND_URL') : ''),
  );
  const workerUrl = normalizedOrigin(
    envValue(env, 'ASF_WORKER_URL')
      || envValue(env, 'VITE_API_BASE_URL')
      || (target === 'sandbox' ? envValue(env, 'ASF_SANDBOX_WORKER_URL') : ''),
  );
  const clerkIssuer = normalizedOrigin(envValue(env, 'CLERK_ISSUER'));
  const backendAuthBridgeSecret = envValue(env, 'CLERK_BACKEND_AUTH_BRIDGE_SECRET');
  if (!secretKey.startsWith(config.secretPrefix)) {
    throw new Error(`${target} ASF_LAUNCH_SMOKE_CLERK_KEY is required and must match its Clerk instance.`);
  }
  if (frontendOrigin !== config.expectedFrontendOrigin) {
    throw new Error(`${target} launch smoke is pinned to ${config.expectedFrontendOrigin}.`);
  }
  if (workerUrl !== config.expectedWorkerUrl) {
    throw new Error(`${target} launch smoke is pinned to ${config.expectedWorkerUrl}.`);
  }
  if (clerkIssuer !== config.expectedClerkIssuer) {
    throw new Error(`${target} launch smoke requires the expected Insert Player Clerk issuer.`);
  }
  if (backendAuthBridgeSecret.length < 32) {
    throw new Error(`${target} launch smoke requires CLERK_BACKEND_AUTH_BRIDGE_SECRET with at least 32 characters.`);
  }
  return {
    ...config,
    secretKey,
    frontendOrigin,
    workerUrl,
    clerkIssuer,
    backendAuthBridgeSecret,
  };
}

async function main() {
  const target = parseSmokeTarget(args);
  if (target === 'production' && !args.includes('--confirm-production')) {
    throw new Error('Pass --confirm-production to run the mutating production launch smoke.');
  }
  const env = readEnvValues(target);
  const config = validateTargetConfiguration(target, env);
  const artifactDir = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, `insert-player-${target}-launch-smoke`)
    : '';
  const clerk = createClerkClient({ secretKey: config.secretKey });
  const runId = launchSmokeRunId();
  let browser = null;
  let primaryUser = null;
  let cloneUser = null;
  let primaryAuth = null;
  let cloneAuth = null;
  const errors = [];

  try {
    if (target === 'sandbox') {
      primaryUser = await createSandboxSmokeUser(clerk, runId, 'primary');
      cloneUser = await createSandboxSmokeUser(clerk, runId, 'clone');
      console.log('\u2713 created two isolated sandbox Clerk users');
    } else {
      ({ primaryUser, cloneUser } = await loadProductionQaUsers(
        clerk,
        envValue(env, 'ASF_LAUNCH_SMOKE_PRIMARY_USER_ID'),
        envValue(env, 'ASF_LAUNCH_SMOKE_CLONE_USER_ID'),
      ));
      console.log('\u2713 verified two dedicated production OAuth QA users');
    }

    browser = await chromium.launch({ headless: true });
    primaryAuth = await createAgentTaskBackedToken({
      clerk,
      browser,
      user: primaryUser,
      role: 'primary',
      frontendOrigin: config.frontendOrigin,
      clerkIssuer: config.clerkIssuer,
      artifactDir,
    });
    cloneAuth = await createAgentTaskBackedToken({
      clerk,
      browser,
      user: cloneUser,
      role: 'clone',
      frontendOrigin: config.frontendOrigin,
      clerkIssuer: config.clerkIssuer,
      artifactDir,
    });
    console.log(`\u2713 captured two distinct ${target} Clerk Agent Task sessions`);
    await browser.close();
    browser = null;

    runAuthenticatedLiveSmoke(
      primaryAuth.token,
      cloneAuth.token,
      target,
      config.preserveUserState,
      config.backendAuthBridgeSecret,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  } finally {
    if (browser) await browser.close().catch((error) => errors.push(error));
    if (target === 'sandbox') {
      let cloneDeleted = false;
      let primaryDeleted = false;
      try {
        cloneDeleted = await deleteSandboxSmokeUser(clerk, cloneUser, 'clone');
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      try {
        primaryDeleted = await deleteSandboxSmokeUser(clerk, primaryUser, 'primary');
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      if (cloneDeleted && cloneAuth?.token) {
        try {
          await waitForDeletedTokenRejection({
            token: cloneAuth.token,
            workerUrl: config.workerUrl,
            frontendOrigin: config.frontendOrigin,
            role: 'clone',
          });
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (primaryDeleted && primaryAuth?.token) {
        try {
          await waitForDeletedTokenRejection({
            token: primaryAuth.token,
            workerUrl: config.workerUrl,
            frontendOrigin: config.frontendOrigin,
            role: 'primary',
          });
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } else {
      try {
        await revokeProductionQaSession(clerk, cloneAuth?.sessionId, 'clone');
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      try {
        await revokeProductionQaSession(clerk, primaryAuth?.sessionId, 'primary');
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Automated ${target} launch smoke failed.`);
  }
  if (target === 'sandbox') {
    console.log('Sandbox Clerk, D1, R2, clone, privacy, and account-deletion smoke passed.');
  } else {
    console.log('Production Clerk OAuth, D1, R2, clone, privacy, and session-revocation smoke passed.');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    if (error instanceof AggregateError) {
      console.error(error.message);
      for (const cause of error.errors) console.error(`- ${formatSmokeError(cause)}`);
    } else {
      console.error(formatSmokeError(error));
    }
    process.exit(1);
  });
}
