import { describe, expect, it, vi } from 'vitest';
import { clerkFrontendApiFromPublishableKey, openClerkAdminSession } from './seed-arcade-roster.mjs';

describe('run-owned Arcade admin session', () => {
  it('derives the Frontend API host from a publishable key', () => {
    const key = `pk_live_${Buffer.from('clerk.insertplayer.ai$').toString('base64')}`;
    expect(clerkFrontendApiFromPublishableKey(key)).toBe('clerk.insertplayer.ai');
    expect(clerkFrontendApiFromPublishableKey('not-a-key')).toBeNull();
  });

  it('mints a one-time sign-in token and redeems it headlessly for the admin only', async () => {
    const calls = [];
    const request = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (String(url).endsWith('/sign_in_tokens')) return new Response(JSON.stringify({ token: 'ticket-123' }), { status: 200 });
      return new Response(JSON.stringify({ response: { status: 'complete', created_session_id: 'sess_abc' } }), { status: 200 });
    });
    await expect(openClerkAdminSession('sk_test', 'user_admin', 'clerk.insertplayer.ai', request)).resolves.toBe('sess_abc');
    expect(calls[0][0]).toBe('https://api.clerk.com/v1/sign_in_tokens');
    expect(JSON.parse(calls[0][1].body)).toEqual({ user_id: 'user_admin', expires_in_seconds: 120 });
    expect(calls[1][0]).toBe('https://clerk.insertplayer.ai/v1/client/sign_ins?_is_native=1');
    expect(String(calls[1][1].body)).toBe('strategy=ticket&ticket=ticket-123');
  });

  it('fails closed when the headless sign-in does not complete', async () => {
    const request = vi.fn(async (url) => String(url).endsWith('/sign_in_tokens')
      ? new Response(JSON.stringify({ token: 't' }), { status: 200 })
      : new Response(JSON.stringify({ response: { status: 'needs_second_factor' } }), { status: 200 }));
    await expect(openClerkAdminSession('sk', 'user_admin', 'clerk.insertplayer.ai', request)).rejects.toThrow(/headless Arcade admin sign-in failed/);
  });
});
