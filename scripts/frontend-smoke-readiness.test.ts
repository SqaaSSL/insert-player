import { describe, expect, it } from 'vitest';
import { frontendShellReadinessError } from './frontend-smoke-readiness.mjs';

const appShell = '<!doctype html><div id="app"></div>';
const clerkOrigin = 'https://clerk.insertplayer.ai';

describe('frontend deployment propagation readiness', () => {
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

  it('does not accept an unrelated successful HTML response', () => {
    expect(frontendShellReadinessError({
      html: '<!doctype html><main>Coming soon</main>',
      cspHeader: `script-src 'self' https://challenges.cloudflare.com ${clerkOrigin}`,
      expectedClerkOrigin: clerkOrigin,
    })).toBe('the current response is not the app shell');
  });
});
