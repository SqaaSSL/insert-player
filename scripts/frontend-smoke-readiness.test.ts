import { describe, expect, it } from 'vitest';
import {
  frontendAssetProbeUrl,
  frontendShellReadinessError,
  parsePositiveTimeoutMs,
} from './frontend-smoke-readiness.mjs';

const appShell = '<!doctype html><div id="app"></div>';
const clerkOrigin = 'https://clerk.insertplayer.ai';

describe('frontend deployment propagation readiness', () => {
  it('accepts only positive numeric timeout values', () => {
    expect(parsePositiveTimeoutMs('', 30_000, 'TEST_TIMEOUT_MS')).toBe(30_000);
    expect(parsePositiveTimeoutMs('30000', 1, 'TEST_TIMEOUT_MS')).toBe(30_000);
    expect(() => parsePositiveTimeoutMs('30_000', 1, 'TEST_TIMEOUT_MS')).toThrow(
      'TEST_TIMEOUT_MS must be a positive number of milliseconds',
    );
    expect(() => parsePositiveTimeoutMs('0', 1, 'TEST_TIMEOUT_MS')).toThrow(
      'TEST_TIMEOUT_MS must be a positive number of milliseconds',
    );
  });

  it('uses an isolated cache key while a new immutable asset propagates', () => {
    expect(frontendAssetProbeUrl(
      'https://insertplayer.ai',
      '/assets/index-current.js',
      'deploy-123',
    )).toBe('https://insertplayer.ai/assets/index-current.js?__insert_player_readiness=deploy-123');
    expect(frontendAssetProbeUrl(
      'https://insertplayer.ai',
      '/assets/index-current.js',
      '',
    )).toBe('https://insertplayer.ai/assets/index-current.js');
  });

  it('keeps waiting while the custom domain serves the prelaunch CSP', () => {
    expect(frontendShellReadinessError({
      html: appShell,
      cspHeader: "default-src 'self'; script-src 'self'; frame-src 'none'",
      expectedClerkOrigin: clerkOrigin,
    })).toBe('script-src is missing https://challenges.cloudflare.com');
  });

  it('accepts the live shell once Turnstile and Clerk are present', () => {
    expect(frontendShellReadinessError({
      html: appShell,
      cspHeader: `default-src 'self'; script-src 'self' https://challenges.cloudflare.com ${clerkOrigin}`,
      expectedClerkOrigin: clerkOrigin,
    })).toBe('');
  });

  it('keeps waiting until the custom domain references the asset from this build', () => {
    expect(frontendShellReadinessError({
      html: `${appShell}<script type="module" src="/assets/index-old.js"></script>`,
      cspHeader: `script-src 'self' https://challenges.cloudflare.com ${clerkOrigin}`,
      expectedClerkOrigin: clerkOrigin,
      expectedAssetPath: '/assets/index-current.js',
    })).toBe('the app shell does not reference deployed asset /assets/index-current.js');

    expect(frontendShellReadinessError({
      html: `${appShell}<script type="module" src="/assets/index-current.js"></script>`,
      cspHeader: `script-src 'self' https://challenges.cloudflare.com ${clerkOrigin}`,
      expectedClerkOrigin: clerkOrigin,
      expectedAssetPath: '/assets/index-current.js',
    })).toBe('');
  });

  it('keeps waiting for metadata-only releases that reuse the same JavaScript asset', () => {
    const sharedAsset = '<script type="module" src="/assets/index-current.js"></script>';
    const expectedSocialCard = 'property="og:image" content="https://insertplayer.ai/assets/social-card-v3.png"';
    expect(frontendShellReadinessError({
      html: `${appShell}${sharedAsset}<meta property="og:image" content="https://insertplayer.ai/assets/social-card-v2.png" />`,
      cspHeader: `script-src 'self' https://challenges.cloudflare.com ${clerkOrigin}`,
      expectedClerkOrigin: clerkOrigin,
      expectedAssetPath: '/assets/index-current.js',
      expectedHtmlFragments: [expectedSocialCard],
    })).toBe(`the app shell is missing release marker ${expectedSocialCard}`);

    expect(frontendShellReadinessError({
      html: `${appShell}${sharedAsset}<meta ${expectedSocialCard} />`,
      cspHeader: `script-src 'self' https://challenges.cloudflare.com ${clerkOrigin}`,
      expectedClerkOrigin: clerkOrigin,
      expectedAssetPath: '/assets/index-current.js',
      expectedHtmlFragments: [expectedSocialCard],
    })).toBe('');
  });

  it('does not accept an unrelated successful HTML response', () => {
    expect(frontendShellReadinessError({
      html: '<!doctype html><main>Coming soon</main>',
      cspHeader: `script-src 'self' https://challenges.cloudflare.com ${clerkOrigin}`,
      expectedClerkOrigin: clerkOrigin,
    })).toBe('the current response is not the app shell');
  });
});
