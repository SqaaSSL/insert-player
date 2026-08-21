import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './types';
import {
  anonymousRookieIsEnabled,
  enforceAnonymousRookieTurnstile,
  turnstileConfigurationStatus,
} from './turnstile';

const productionEnv = {
  ENVIRONMENT: 'production',
  TURNSTILE_REQUIRED: 'true',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
  TURNSTILE_ACTION: 'anonymous_rookie',
  TURNSTILE_HOSTNAMES: 'insertplayer.ai,www.insertplayer.ai',
} as Env;

function request(): Request {
  return new Request('https://api.insertplayer.ai/api/billing/generation', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.9' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anonymous Rookie Turnstile enforcement', () => {
  it('fails closed when production configuration is incomplete', async () => {
    const env = { ...productionEnv, TURNSTILE_SECRET_KEY: undefined } as Env;

    expect(turnstileConfigurationStatus(env)).toBe('misconfigured');
    const response = await enforceAnonymousRookieTurnstile(request(), env, 'token');

    expect(response?.status).toBe(503);
  });

  it('rejects a missing token before calling Siteverify', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await enforceAnonymousRookieTurnstile(request(), productionEnv, null);

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ code: 'turnstile_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a valid token with the expected action and hostname', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get('secret')).toBe('turnstile-secret');
      expect(form.get('response')).toBe('valid-token');
      expect(form.get('remoteip')).toBe('203.0.113.9');
      return Response.json({
        success: true,
        action: 'anonymous_rookie',
        hostname: 'insertplayer.ai',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await enforceAnonymousRookieTurnstile(request(), productionEnv, 'valid-token');

    expect(response).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects valid-looking tokens issued for another action or hostname', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      success: true,
      action: 'newsletter_signup',
      hostname: 'attacker.example',
    })));

    const response = await enforceAnonymousRookieTurnstile(request(), productionEnv, 'wrong-surface-token');

    expect(response?.status).toBe(403);
  });

  it('rejects tokens issued for the production Pages preview hostname', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      success: true,
      action: 'anonymous_rookie',
      hostname: 'insert-player.pages.dev',
    })));

    const response = await enforceAnonymousRookieTurnstile(request(), productionEnv, 'preview-host-token');

    expect(response?.status).toBe(403);
  });

  it('can remain disabled for local development only', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = { ENVIRONMENT: 'development' } as Env;

    expect(turnstileConfigurationStatus(env)).toBe('disabled');
    expect(await enforceAnonymousRookieTurnstile(request(), env, null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks anonymous provider sessions when an isolated environment disables Rookie', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      ENVIRONMENT: 'sandbox',
      ANONYMOUS_ROOKIE_ENABLED: 'false',
      TURNSTILE_REQUIRED: 'false',
    } as Env;

    expect(anonymousRookieIsEnabled(env)).toBe(false);
    const response = await enforceAnonymousRookieTurnstile(request(), env, null);

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ code: 'anonymous_rookie_disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
