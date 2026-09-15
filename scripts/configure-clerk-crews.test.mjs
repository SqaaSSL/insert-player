import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_CLERK_WEBHOOK_URL,
  REQUIRED_CLERK_WEBHOOK_EVENTS,
  configureClerkCrews,
  parseSvixPortalUrl,
} from './configure-clerk-crews.mjs';

const INSTANCE_ID = `ins_${'I'.repeat(27)}`;
const OTHER_INSTANCE_ID = `ins_${'J'.repeat(27)}`;
const APP_ID = `app_${'A'.repeat(27)}`;
const ENDPOINT_ID = `ep_${'E'.repeat(27)}`;
const ONE_TIME_TOKEN = `ott_${'O'.repeat(32)}`;
const PORTAL_TOKEN = `app_${'T'.repeat(48)}`;
const CLERK_SECRET_KEY = `sk_live_${'K'.repeat(32)}`;
const SIGNING_SECRET = `whsec_${'S'.repeat(32)}`;

function json(value, options = {}) {
  return new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

function portalUrl(overrides = {}) {
  const payload = {
    appId: APP_ID,
    oneTimeToken: ONE_TIME_TOKEN,
    region: 'us',
    ...overrides,
  };
  const key = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `https://app.svix.com/login#key=${encodeURIComponent(key)}`;
}

function createFixture({
  endpointDisabled = true,
  endpointEvents = null,
  instanceId = INSTANCE_ID,
  organizationsEnabled = false,
  signingSecret = SIGNING_SECRET,
} = {}) {
  const state = {
    endpoint: {
      id: ENDPOINT_ID,
      url: PRODUCTION_CLERK_WEBHOOK_URL,
      disabled: endpointDisabled,
      eventTypes: endpointEvents,
    },
    organizationsEnabled,
  };
  const calls = [];

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ body, method, url: url.toString(), authorization: headers.get('Authorization') });

    if (url.toString() === 'https://clerk.insertplayer.ai/v1/environment') {
      return json({ organization_settings: { force_organization_selection: false } }, {
        headers: { 'x-clerk-instance-id': INSTANCE_ID },
      });
    }
    if (url.toString() === 'https://api.clerk.com/v1/instance' && method === 'GET') {
      return json({ id: instanceId, environment_type: 'production' });
    }
    if (url.toString() === 'https://api.clerk.com/v1/instance/organization_settings') {
      if (method === 'PATCH') state.organizationsEnabled = body.enabled;
      return json({ enabled: state.organizationsEnabled });
    }
    if (url.toString() === 'https://api.clerk.com/v1/webhooks/svix_url' && method === 'POST') {
      return json({ svix_url: portalUrl() });
    }
    if (url.toString() === 'https://app.svix.com/api/us/api/v1/auth/one-time-token') {
      return json({ capabilities: [], token: PORTAL_TOKEN });
    }
    if (
      url.origin === 'https://api.us.svix.com'
      && url.pathname === `/api/v1/app/${APP_ID}/endpoint`
      && method === 'GET'
    ) {
      return json({ data: [{ ...state.endpoint }], done: true, iterator: null });
    }
    if (
      url.toString() === `https://api.us.svix.com/api/v1/app/${APP_ID}/endpoint/${ENDPOINT_ID}/secret`
    ) {
      return json({ key: signingSecret });
    }
    if (
      url.toString() === `https://api.us.svix.com/api/v1/app/${APP_ID}/endpoint/${ENDPOINT_ID}`
    ) {
      if (method === 'PATCH') state.endpoint = { ...state.endpoint, ...body };
      return json({ ...state.endpoint });
    }
    if (
      url.toString() === `https://api.us.svix.com/${['api', 'v1', 'auth', 'logout'].join('/')}`
      && method === 'POST'
    ) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  return { calls, fetchImpl, state };
}

describe('production Clerk Crew configuration', () => {
  it('parses only a public, region-pinned Svix portal URL', () => {
    expect(parseSvixPortalUrl(portalUrl())).toEqual({
      appId: APP_ID,
      oneTimeToken: ONE_TIME_TOKEN,
      portalApiBase: 'https://app.svix.com/api/us',
      region: 'us',
      svixApiBase: 'https://api.us.svix.com',
    });
    expect(() => parseSvixPortalUrl(portalUrl({ region: 'moon' }))).toThrow(/region is not allowed/i);
    expect(() => parseSvixPortalUrl(
      portalUrl({ serverUrl: 'https://attacker.example' }),
    )).toThrow(/outside the allowed production region/i);
    const key = new URL(portalUrl()).hash;
    expect(() => parseSvixPortalUrl(`https://attacker.example/login${key}`)).toThrow(/public Svix app portal/i);
  });

  it('configures and verifies the webhook before enabling Organizations', async () => {
    const fixture = createFixture();
    const result = await configureClerkCrews({
      apply: true,
      fetchImpl: fixture.fetchImpl,
      secretKey: CLERK_SECRET_KEY,
      signingSecret: SIGNING_SECRET,
    });

    expect(result).toEqual({
      applied: true,
      organizationsNeedUpdate: true,
      organizationsUpdated: true,
      webhookNeedsUpdate: true,
      webhookUpdated: true,
    });
    expect(fixture.state.endpoint).toMatchObject({
      disabled: false,
      eventTypes: REQUIRED_CLERK_WEBHOOK_EVENTS,
    });
    expect(fixture.state.organizationsEnabled).toBe(true);

    const webhookPatch = fixture.calls.findIndex((call) => (
      call.method === 'PATCH' && call.url.includes(`/endpoint/${ENDPOINT_ID}`)
    ));
    const organizationsPatch = fixture.calls.findIndex((call) => (
      call.method === 'PATCH' && call.url.endsWith('/instance/organization_settings')
    ));
    expect(webhookPatch).toBeGreaterThan(-1);
    expect(organizationsPatch).toBeGreaterThan(webhookPatch);
    expect(fixture.calls[webhookPatch].body).toEqual({
      disabled: false,
      eventTypes: REQUIRED_CLERK_WEBHOOK_EVENTS,
    });
    expect(fixture.calls[organizationsPatch].body).toEqual({ enabled: true });
    expect(fixture.calls.some((call) => (
      call.url.endsWith(['/auth', 'logout'].join('/'))
      && call.authorization === `Bearer ${PORTAL_TOKEN}`
    ))).toBe(true);
  });

  it('is idempotent when the production policy is already current', async () => {
    const fixture = createFixture({
      endpointDisabled: false,
      endpointEvents: [...REQUIRED_CLERK_WEBHOOK_EVENTS].reverse(),
      organizationsEnabled: true,
    });
    const result = await configureClerkCrews({
      apply: true,
      fetchImpl: fixture.fetchImpl,
      secretKey: CLERK_SECRET_KEY,
      signingSecret: SIGNING_SECRET,
    });

    expect(result).toMatchObject({
      organizationsNeedUpdate: false,
      organizationsUpdated: false,
      webhookNeedsUpdate: false,
      webhookUpdated: false,
    });
    expect(fixture.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('reports pending changes without mutating them in dry-run mode', async () => {
    const fixture = createFixture();
    const result = await configureClerkCrews({
      fetchImpl: fixture.fetchImpl,
      secretKey: CLERK_SECRET_KEY,
      signingSecret: SIGNING_SECRET,
    });

    expect(result).toMatchObject({
      applied: false,
      organizationsNeedUpdate: true,
      organizationsUpdated: false,
      webhookNeedsUpdate: true,
      webhookUpdated: false,
    });
    expect(fixture.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect(fixture.state.organizationsEnabled).toBe(false);
  });

  it('fails closed before activation when the webhook signing secret differs', async () => {
    const fixture = createFixture({ signingSecret: `whsec_${'X'.repeat(32)}` });
    let message = '';
    try {
      await configureClerkCrews({
        apply: true,
        fetchImpl: fixture.fetchImpl,
        secretKey: CLERK_SECRET_KEY,
        signingSecret: SIGNING_SECRET,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/signing secret does not match/i);
    expect(message).not.toContain(SIGNING_SECRET);
    expect(fixture.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect(fixture.state.organizationsEnabled).toBe(false);
  });

  it('rejects a live key for any other Clerk instance', async () => {
    const fixture = createFixture({ instanceId: OTHER_INSTANCE_ID });
    await expect(configureClerkCrews({
      apply: true,
      fetchImpl: fixture.fetchImpl,
      secretKey: CLERK_SECRET_KEY,
      signingSecret: SIGNING_SECRET,
    })).rejects.toThrow(/does not match the public Insert Player Production instance/i);
    expect(fixture.calls.some((call) => call.url.endsWith('/webhooks/svix_url'))).toBe(false);
  });
});
