import { describe, expect, it } from 'vitest';
import { frontendHeadersForTarget } from './frontend-security-headers.mjs';

describe('frontend deployment CSP', () => {
  it('trusts only the production API and Clerk Frontend API in live builds', () => {
    const headers = frontendHeadersForTarget({
      target: 'live',
      apiOrigin: 'https://api.insertplayer.ai',
      clerkFrontendApiOrigin: 'https://clerk.insertplayer.ai',
    });
    expect(headers).toContain('https://api.insertplayer.ai');
    expect(headers).toContain('https://clerk.insertplayer.ai');
    expect(headers).not.toContain('insert-player-api-sandbox');
    expect(headers).not.toContain('clerk.accounts.dev');
  });

  it('trusts only the isolated API and exact Clerk Development host in sandbox builds', () => {
    const headers = frontendHeadersForTarget({
      target: 'sandbox',
      apiOrigin: 'https://insert-player-api-sandbox.shellbot.workers.dev',
      clerkFrontendApiOrigin: 'https://right-cricket-1317.clerk.accounts.dev',
    });
    expect(headers).toContain('https://insert-player-api-sandbox.shellbot.workers.dev');
    expect(headers).toContain('https://right-cricket-1317.clerk.accounts.dev');
    expect(headers).not.toContain('https://api.insertplayer.ai');
    expect(headers).not.toContain('https://clerk.insertplayer.ai');
    expect(headers).not.toContain('https://*.clerk.accounts.dev');
  });

  it('permits no external origins in prelaunch mode', () => {
    const headers = frontendHeadersForTarget({ target: 'prelaunch' });
    expect(headers).toContain("script-src 'self'");
    expect(headers).toContain("connect-src 'self'");
    expect(headers).toContain("frame-src 'none'");
    expect(headers).not.toContain('https://');
  });

  it('rejects malformed origins', () => {
    expect(() => frontendHeadersForTarget({
      target: 'live',
      apiOrigin: 'https://api.insertplayer.ai/path',
      clerkFrontendApiOrigin: 'https://clerk.insertplayer.ai',
    })).toThrow('apiOrigin must be an HTTPS origin');
  });
});
