import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClerkClient } from '@clerk/backend';
import { isClerkAPIResponseError } from '@clerk/backend/errors';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const EXPECTED_FRONTEND_ORIGIN = 'https://insertplayer.ai';
const EXPECTED_WORKER_URL = 'https://api.insertplayer.ai';
const TOKEN_TTL_SECONDS = 10 * 60;
const BROWSER_TIMEOUT_MS = 90_000;
const TOMBSTONE_TIMEOUT_MS = 90_000;
const LIVE_SMOKE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DIAGNOSTIC_LENGTH = 1_200;

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

function readEnvValues() {
  const values = new Map();
  for (const file of ['.env.production.local', '.env.production', '.env.local', '.env']) {
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
  minRemainingSeconds = 10,
  nowMs = Date.now(),
}) {
  const claims = decodeJwtPayload(token);
  if (claims.sub !== userId) throw new Error('Clerk launch-smoke token belongs to a different user.');
  if (normalizedOrigin(String(claims.azp ?? '')) !== normalizedOrigin(frontendOrigin)) {
    throw new Error('Clerk launch-smoke token is missing the production authorized party.');
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

async function captureFrontendSessionToken({
  browser,
  agentTaskUrl,
  frontendOrigin,
  workerUrl,
  role,
  artifactDir,
}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let tokenResolver = null;
  let tokenRejecter = null;
  const tokenPromise = new Promise((resolveToken, rejectToken) => {
    tokenResolver = resolveToken;
    tokenRejecter = rejectToken;
  });
  void tokenPromise.catch(() => {});
  const tokenTimeout = setTimeout(
    () => tokenRejecter?.(new Error('Timed out waiting for the frontend Clerk bearer token.')),
    BROWSER_TIMEOUT_MS,
  );
  const authMeUrl = `${workerUrl}/auth/me`;

  page.on('request', (request) => {
    if (request.url().split('?')[0] !== authMeUrl) return;
    const authorization = request.headers().authorization ?? '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) tokenResolver?.(match[1]);
  });

  try {
    const response = await page.goto(agentTaskUrl, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_TIMEOUT_MS,
    });
    if (response && !response.ok()) {
      const responseText = await response.text().catch(() => 'No response body was available.');
      throw new Error(
        `Clerk Agent Task navigation failed with HTTP ${response.status()}: ${redactSmokeDiagnostic(responseText)}`,
      );
    }
    await page.waitForURL((candidate) => (
      candidate.origin === frontendOrigin && candidate.pathname === '/menu'
    ), { timeout: BROWSER_TIMEOUT_MS });
    return await tokenPromise;
  } catch (err) {
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({ path: join(artifactDir, `${role}-failure.png`), fullPage: true }).catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(tokenTimeout);
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

export function buildSmokeUserParams(runId, role) {
  return {
    externalId: `insert-player-launch-smoke:${runId}:${role}`,
    emailAddress: [`launch-smoke+${runId.slice(0, 32)}-${role}@example.com`],
    privateMetadata: {
      insertPlayerLaunchSmoke: true,
      launchSmokeRunId: runId,
      launchSmokeRole: role,
    },
  };
}

async function createSmokeUser(clerk, runId, role) {
  try {
    // Agent Tasks need an identification; this ephemeral address never enables email auth in the app.
    return await clerk.users.createUser(buildSmokeUserParams(runId, role));
  } catch (error) {
    throw new Error(`Could not create the ephemeral ${role} Clerk user: ${formatSmokeError(error)}`);
  }
}

async function createBrowserBackedToken({
  clerk,
  browser,
  user,
  role,
  frontendOrigin,
  workerUrl,
  clerkIssuer,
  artifactDir,
}) {
  const task = await clerk.agentTasks.create({
    onBehalfOf: { userId: user.id },
    permissions: '*',
    agentName: 'insert-player-launch-smoke',
    taskDescription: `Production launch smoke (${role})`,
    redirectUrl: `${frontendOrigin}/menu`,
    sessionMaxDurationInSeconds: 15 * 60,
  });
  const shortToken = await captureFrontendSessionToken({
    browser,
    agentTaskUrl: task.url,
    frontendOrigin,
    workerUrl,
    role,
    artifactDir,
  });
  const { sessionId } = validateLaunchSmokeToken(shortToken, {
    userId: user.id,
    frontendOrigin,
    clerkIssuer,
  });
  const refreshed = await clerk.sessions.getToken(sessionId, undefined, TOKEN_TTL_SECONDS);
  validateLaunchSmokeToken(refreshed.jwt, {
    userId: user.id,
    frontendOrigin,
    clerkIssuer,
    minRemainingSeconds: 8 * 60,
  });
  return refreshed.jwt;
}

function runAuthenticatedLiveSmoke(primaryToken, cloneToken) {
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
      },
      timeout: LIVE_SMOKE_TIMEOUT_MS,
    },
  );
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error('Authenticated production smoke timed out after 10 minutes.');
    }
    throw result.error;
  }
  if (result.signal) throw new Error(`Authenticated production smoke exited with signal ${result.signal}.`);
  if (result.status !== 0) {
    throw new Error(`Authenticated production smoke failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      console.log(`✓ ${role} Clerk deletion tombstones its still-valid session token`);
      return;
    }
    await response.body?.cancel().catch(() => {});
    await sleep(2_000);
  }
  throw new Error(`${role} deleted Clerk token remained usable (last HTTP ${lastStatus || 'unknown'}).`);
}

async function deleteSmokeUser(clerk, user, role) {
  if (!user?.id) return false;
  await clerk.users.deleteUser(user.id);
  console.log(`✓ deleted ephemeral ${role} Clerk user`);
  return true;
}

async function main() {
  if (!args.has('--confirm-production')) {
    throw new Error('Pass --confirm-production to run the mutating production launch smoke.');
  }
  const env = readEnvValues();
  const secretKey = envValue(env, 'ASF_LAUNCH_SMOKE_CLERK_KEY');
  const frontendOrigin = normalizedOrigin(
    envValue(env, 'ASF_FRONTEND_ORIGIN') || envValue(env, 'ASF_FRONTEND_URL'),
  );
  const workerUrl = normalizedOrigin(
    envValue(env, 'ASF_WORKER_URL') || envValue(env, 'VITE_API_BASE_URL'),
  );
  const clerkIssuer = normalizedOrigin(envValue(env, 'CLERK_ISSUER'));
  if (!secretKey.startsWith('sk_live_')) {
    throw new Error('Production ASF_LAUNCH_SMOKE_CLERK_KEY is required.');
  }
  if (frontendOrigin !== EXPECTED_FRONTEND_ORIGIN) {
    throw new Error(`Launch smoke is pinned to ${EXPECTED_FRONTEND_ORIGIN}.`);
  }
  if (workerUrl !== EXPECTED_WORKER_URL) {
    throw new Error(`Launch smoke is pinned to ${EXPECTED_WORKER_URL}.`);
  }
  if (clerkIssuer !== 'https://clerk.insertplayer.ai') {
    throw new Error('Launch smoke requires the production Insert Player Clerk issuer.');
  }

  const artifactDir = process.env.RUNNER_TEMP
    ? join(process.env.RUNNER_TEMP, 'insert-player-launch-smoke')
    : '';
  const clerk = createClerkClient({ secretKey });
  const runId = launchSmokeRunId();
  let browser = null;
  let primaryUser = null;
  let cloneUser = null;
  let primaryToken = '';
  let cloneToken = '';
  const errors = [];

  try {
    primaryUser = await createSmokeUser(clerk, runId, 'primary');
    cloneUser = await createSmokeUser(clerk, runId, 'clone');
    console.log('✓ created two isolated Clerk launch-smoke users');

    browser = await chromium.launch({ headless: true });
    primaryToken = await createBrowserBackedToken({
      clerk,
      browser,
      user: primaryUser,
      role: 'primary',
      frontendOrigin,
      workerUrl,
      clerkIssuer,
      artifactDir,
    });
    cloneToken = await createBrowserBackedToken({
      clerk,
      browser,
      user: cloneUser,
      role: 'clone',
      frontendOrigin,
      workerUrl,
      clerkIssuer,
      artifactDir,
    });
    console.log('✓ captured two distinct browser-backed Clerk tokens for insertplayer.ai');
    await browser.close();
    browser = null;

    runAuthenticatedLiveSmoke(primaryToken, cloneToken);
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  } finally {
    if (browser) await browser.close().catch((err) => errors.push(err));
    let cloneDeleted = false;
    let primaryDeleted = false;
    try {
      cloneDeleted = await deleteSmokeUser(clerk, cloneUser, 'clone');
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
    try {
      primaryDeleted = await deleteSmokeUser(clerk, primaryUser, 'primary');
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
    if (cloneDeleted && cloneToken) {
      try {
        await waitForDeletedTokenRejection({
          token: cloneToken,
          workerUrl,
          frontendOrigin,
          role: 'clone',
        });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (primaryDeleted && primaryToken) {
      try {
        await waitForDeletedTokenRejection({
          token: primaryToken,
          workerUrl,
          frontendOrigin,
          role: 'primary',
        });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Automated production launch smoke failed.');
  }
  console.log('Automated production Clerk, D1, R2, clone, privacy, and deletion smoke passed.');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    if (err instanceof AggregateError) {
      console.error(err.message);
      for (const cause of err.errors) console.error(`- ${formatSmokeError(cause)}`);
    } else {
      console.error(formatSmokeError(err));
    }
    process.exit(1);
  });
}
