import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProductionDeployAllowed } from './production-deploy-guard.mjs';

export const CLERK_API_VERSION = '2026-05-12';
export const PRODUCTION_CLERK_ENVIRONMENT_URL = 'https://clerk.insertplayer.ai/v1/environment';
export const PRODUCTION_CLERK_WEBHOOK_URL = 'https://api.insertplayer.ai/api/clerk/webhook';
export const REQUIRED_CLERK_WEBHOOK_EVENTS = Object.freeze([
  'user.created',
  'user.updated',
  'user.deleted',
  'organizationInvitation.accepted',
  'organizationMembership.deleted',
  'organization.deleted',
]);

const CLERK_API_BASE = 'https://api.clerk.com/v1';
const ALLOWED_SVIX_REGIONS = new Set(['us', 'eu', 'ca', 'au', 'in']);
const PRODUCTION_CONFIRMATION = 'ENABLE_PRODUCTION_CLERK_CREWS';
const REQUEST_TIMEOUT_MS = 20_000;
const SVIX_LOGOUT_PATH = ['/api/v1/auth', 'logout'].join('/');

function requiredString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function safeId(value, pattern, label) {
  const normalized = requiredString(value, label);
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function normalizeBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  return `${normalized}${'='.repeat(padding)}`;
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function requestJson(fetchImpl, url, {
  label,
  method = 'GET',
  token,
  headers = {},
  body,
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${label} request failed.`);
  }
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  const text = await response.text();
  return text ? parseJsonText(text, label) : null;
}

async function clerkRequest(fetchImpl, secretKey, path, options = {}) {
  return requestJson(fetchImpl, `${CLERK_API_BASE}${path}`, {
    ...options,
    token: secretKey,
    headers: {
      'Clerk-API-Version': CLERK_API_VERSION,
      ...options.headers,
    },
  });
}

function normalizedWebhookUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
    ) return '';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${path}`;
  } catch {
    return '';
  }
}

function sameEventSet(actual, expected = REQUIRED_CLERK_WEBHOOK_EVENTS) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return [...actual].sort().every((event, index) => event === [...expected].sort()[index]);
}

function sameSecret(actual, expected) {
  const actualBytes = Buffer.from(String(actual ?? ''), 'utf8');
  const expectedBytes = Buffer.from(String(expected ?? ''), 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function parseSvixPortalUrl(rawUrl) {
  const value = requiredString(rawUrl, 'Clerk Svix dashboard URL');
  if (value.length > 32_768) throw new Error('Clerk Svix dashboard URL is invalid.');

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Clerk Svix dashboard URL is invalid.');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'app.svix.com'
    || url.port
    || url.username
    || url.password
  ) {
    throw new Error('Clerk Svix dashboard URL must use the public Svix app portal.');
  }

  const params = new URLSearchParams(url.hash.slice(1));
  const encoded = params.get('key');
  if (!encoded || !/^[A-Za-z0-9+/_=-]+$/.test(encoded)) {
    throw new Error('Clerk Svix dashboard URL is missing a valid login key.');
  }

  let login;
  try {
    login = JSON.parse(Buffer.from(normalizeBase64(encoded), 'base64').toString('utf8'));
  } catch {
    throw new Error('Clerk Svix dashboard login key is invalid.');
  }
  if (!login || typeof login !== 'object' || Array.isArray(login)) {
    throw new Error('Clerk Svix dashboard login key is invalid.');
  }

  const region = requiredString(login.region, 'Svix region').toLowerCase();
  if (!ALLOWED_SVIX_REGIONS.has(region)) throw new Error('Svix region is not allowed.');
  const appId = safeId(login.appId, /^app_[A-Za-z0-9]{27}$/, 'Svix application ID');
  const oneTimeToken = requiredString(login.oneTimeToken, 'Svix one-time token');
  if (oneTimeToken.length > 4_096 || /\s/.test(oneTimeToken)) {
    throw new Error('Svix one-time token is invalid.');
  }

  let portalApiBase = `https://app.svix.com/api/${region}`;
  let svixApiBase = `https://api.${region}.svix.com`;
  if (login.serverUrl != null) {
    let serverUrl;
    try {
      serverUrl = new URL(String(login.serverUrl));
    } catch {
      throw new Error('Svix server URL is invalid.');
    }
    const expectedOrigin = `https://api.${region}.svix.com`;
    if (
      serverUrl.origin !== expectedOrigin
      || !['', '/'].includes(serverUrl.pathname)
      || serverUrl.search
      || serverUrl.hash
      || serverUrl.username
      || serverUrl.password
    ) {
      throw new Error('Svix server URL is outside the allowed production region.');
    }
    portalApiBase = expectedOrigin;
    svixApiBase = expectedOrigin;
  }

  return { appId, oneTimeToken, portalApiBase, region, svixApiBase };
}

async function readPublicClerkEnvironment(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(PRODUCTION_CLERK_ENVIRONMENT_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Production Clerk environment request failed.');
  }
  if (!response.ok) {
    throw new Error(`Production Clerk environment failed with HTTP ${response.status}.`);
  }
  const instanceId = safeId(
    response.headers.get('x-clerk-instance-id'),
    /^ins_[A-Za-z0-9]+$/,
    'Production Clerk instance ID',
  );
  const environment = parseJsonText(await response.text(), 'Production Clerk environment');
  if (environment?.organization_settings?.force_organization_selection !== false) {
    throw new Error('Production Clerk must keep personal accounts available during Crew onboarding.');
  }
  return { environment, instanceId };
}

async function listSvixEndpoints(fetchImpl, apiBase, appId, token) {
  const endpoints = [];
  let iterator = '';
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${apiBase}/api/v1/app/${appId}/endpoint`);
    url.searchParams.set('limit', '250');
    if (iterator) url.searchParams.set('iterator', iterator);
    const result = await requestJson(fetchImpl, url, {
      label: 'Svix endpoint list',
      token,
    });
    if (!Array.isArray(result?.data)) throw new Error('Svix endpoint list is invalid.');
    endpoints.push(...result.data);
    if (result.done !== false) return endpoints;
    iterator = safeId(result.iterator, /^ep_[A-Za-z0-9]{27}$/, 'Svix endpoint iterator');
  }
  throw new Error('Svix endpoint list exceeded the safe pagination limit.');
}

async function logoutSvix(fetchImpl, apiBase, token) {
  try {
    await fetchImpl(`${apiBase}${SVIX_LOGOUT_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // The portal token is short-lived. Logout is best-effort and never exposes it in an error.
  }
}

async function configureWebhook({ apply, fetchImpl, secretKey, signingSecret }) {
  const generated = await clerkRequest(fetchImpl, secretKey, '/webhooks/svix_url', {
    label: 'Clerk Svix dashboard URL',
    method: 'POST',
  });
  const portal = parseSvixPortalUrl(generated?.svix_url);
  const exchanged = await requestJson(
    fetchImpl,
    `${portal.portalApiBase}/api/v1/auth/one-time-token`,
    {
      label: 'Svix one-time token exchange',
      method: 'POST',
      token: 'unused',
      body: { oneTimeToken: portal.oneTimeToken },
    },
  );
  const portalToken = requiredString(exchanged?.token, 'Svix portal token');
  if (portalToken.length > 8_192 || /\s/.test(portalToken)) {
    throw new Error('Svix portal token is invalid.');
  }

  try {
    const endpoints = await listSvixEndpoints(
      fetchImpl,
      portal.svixApiBase,
      portal.appId,
      portalToken,
    );
    const expectedUrl = normalizedWebhookUrl(PRODUCTION_CLERK_WEBHOOK_URL);
    const matches = endpoints.filter((endpoint) => normalizedWebhookUrl(endpoint?.url) === expectedUrl);
    if (matches.length !== 1) {
      throw new Error('Production Clerk must have exactly one webhook endpoint for the Insert Player Worker.');
    }

    const endpoint = matches[0];
    const endpointId = safeId(endpoint.id, /^ep_[A-Za-z0-9]{27}$/, 'Svix endpoint ID');
    const secretResult = await requestJson(
      fetchImpl,
      `${portal.svixApiBase}/api/v1/app/${portal.appId}/endpoint/${endpointId}/secret`,
      { label: 'Svix endpoint secret', token: portalToken },
    );
    if (!sameSecret(secretResult?.key, signingSecret)) {
      throw new Error('Production Clerk webhook signing secret does not match the Worker configuration.');
    }

    const needsUpdate = endpoint.disabled === true
      || !sameEventSet(endpoint.eventTypes);
    if (needsUpdate && apply) {
      await requestJson(
        fetchImpl,
        `${portal.svixApiBase}/api/v1/app/${portal.appId}/endpoint/${endpointId}`,
        {
          label: 'Svix endpoint update',
          method: 'PATCH',
          token: portalToken,
          body: {
            disabled: false,
            eventTypes: REQUIRED_CLERK_WEBHOOK_EVENTS,
          },
        },
      );
    }

    if (apply) {
      const verified = await requestJson(
        fetchImpl,
        `${portal.svixApiBase}/api/v1/app/${portal.appId}/endpoint/${endpointId}`,
        { label: 'Svix endpoint verification', token: portalToken },
      );
      if (
        normalizedWebhookUrl(verified?.url) !== expectedUrl
        || verified?.disabled === true
        || !sameEventSet(verified?.eventTypes)
      ) {
        throw new Error('Production Clerk webhook verification failed.');
      }
    }

    return { needsUpdate, updated: needsUpdate && apply };
  } finally {
    await logoutSvix(fetchImpl, portal.svixApiBase, portalToken);
  }
}

export async function configureClerkCrews({
  apply = false,
  fetchImpl = globalThis.fetch,
  secretKey,
  signingSecret,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch implementation is required.');
  const clerkSecretKey = requiredString(secretKey, 'CLERK_SECRET_KEY');
  const webhookSigningSecret = requiredString(signingSecret, 'CLERK_WEBHOOK_SIGNING_SECRET');
  if (!clerkSecretKey.startsWith('sk_live_')) {
    throw new Error('CLERK_SECRET_KEY must belong to the Clerk Production instance.');
  }
  if (!webhookSigningSecret.startsWith('whsec_')) {
    throw new Error('CLERK_WEBHOOK_SIGNING_SECRET must be a Svix signing secret.');
  }

  const publicEnvironment = await readPublicClerkEnvironment(fetchImpl);
  const instance = await clerkRequest(fetchImpl, clerkSecretKey, '/instance', {
    label: 'Clerk instance',
  });
  if (
    instance?.environment_type !== 'production'
    || instance?.id !== publicEnvironment.instanceId
  ) {
    throw new Error('CLERK_SECRET_KEY does not match the public Insert Player Production instance.');
  }

  const organizationSettings = await clerkRequest(
    fetchImpl,
    clerkSecretKey,
    '/instance/organization_settings',
    { label: 'Clerk organization settings' },
  );
  if (typeof organizationSettings?.enabled !== 'boolean') {
    throw new Error('Clerk organization settings response is invalid.');
  }

  const webhook = await configureWebhook({
    apply,
    fetchImpl,
    secretKey: clerkSecretKey,
    signingSecret: webhookSigningSecret,
  });

  const organizationsNeedUpdate = organizationSettings.enabled !== true;
  if (organizationsNeedUpdate && apply) {
    await clerkRequest(fetchImpl, clerkSecretKey, '/instance/organization_settings', {
      label: 'Clerk Organizations enablement',
      method: 'PATCH',
      body: { enabled: true },
    });
  }

  if (apply) {
    const verified = await clerkRequest(fetchImpl, clerkSecretKey, '/instance/organization_settings', {
      label: 'Clerk Organizations verification',
    });
    if (verified?.enabled !== true) throw new Error('Clerk Organizations verification failed.');
  }

  return {
    applied: apply,
    organizationsNeedUpdate,
    organizationsUpdated: organizationsNeedUpdate && apply,
    webhookNeedsUpdate: webhook.needsUpdate,
    webhookUpdated: webhook.updated,
  };
}

async function main(args = process.argv.slice(2), env = process.env) {
  const allowedArgs = new Set(['--apply', '--confirm-production']);
  const unknownArgs = args.filter((argument) => !allowedArgs.has(argument));
  if (unknownArgs.length > 0) throw new Error(`Unknown argument: ${unknownArgs[0]}`);
  const apply = args.includes('--apply');
  if (apply && !args.includes('--confirm-production')) {
    throw new Error('Production Clerk mutation requires --confirm-production.');
  }
  if (apply && env.ASF_CONFIGURE_CLERK_CREWS_CONFIRMATION !== PRODUCTION_CONFIRMATION) {
    throw new Error(`Set ASF_CONFIGURE_CLERK_CREWS_CONFIRMATION=${PRODUCTION_CONFIRMATION} to continue.`);
  }
  if (apply) assertProductionDeployAllowed({ env });

  const result = await configureClerkCrews({
    apply,
    secretKey: env.CLERK_SECRET_KEY,
    signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET,
  });
  if (apply) {
    console.log(
      `Production Clerk Crews are enabled; webhook policy ${result.webhookUpdated ? 'updated' : 'already current'}.`,
    );
  } else {
    const pending = [
      result.webhookNeedsUpdate ? 'webhook policy' : '',
      result.organizationsNeedUpdate ? 'Organizations' : '',
    ].filter(Boolean);
    console.log(pending.length > 0
      ? `Dry run complete; pending: ${pending.join(', ')}.`
      : 'Dry run complete; production Clerk Crews are already configured.');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
