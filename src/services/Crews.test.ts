import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestTimeoutError, configureApiAuth } from './ApiClient.ts';
import { acceptCrewInviteLink, createCrewInviteLink, loadOnboardingStatus, loadReferralLanding, recordDebutWithRecovery, rememberCompletedAuraTrial, syncOnboardingProgress } from './Crews.ts';

const FIGHTER = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const pendingKey = (account: string) => `asf:onboarding:pending-debut:${encodeURIComponent(account)}`;
let values: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  values = new Map();
  vi.stubGlobal('window', { location: { href: 'https://insertplayer.ai/onboarding' } });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai');
  configureApiAuth(async () => 'account-token');
  fetchMock = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  configureApiAuth(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('account-scoped onboarding recovery', () => {
  it('persists before sending and retries a failed debut when the player returns', async () => {
    fetchMock.mockImplementationOnce(async () => {
      expect(JSON.parse(values.get(pendingKey('player-a'))!).fighterId).toBe(FIGHTER);
      throw new Error('offline');
    });
    await expect(recordDebutWithRecovery(FIGHTER, 'player-a')).rejects.toThrow('offline');
    expect(values.has(pendingKey('player-a'))).toBe(true);
    await syncOnboardingProgress('player-a');
    expect(values.has(pendingKey('player-a'))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries another account’s pending debut', async () => {
    values.set(pendingKey('player-a'), JSON.stringify({ fighterId: FIGHTER, at: Date.now() }));
    await syncOnboardingProgress('player-b');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(values.has(pendingKey('player-a'))).toBe(true);
  });

  it('does not discard a newer pending debut when an old response arrives', async () => {
    fetchMock.mockImplementationOnce(async () => {
      values.set(pendingKey('player-a'), JSON.stringify({ fighterId: OTHER, at: Date.now() }));
      return new Response('{}');
    });
    await recordDebutWithRecovery(FIGHTER, 'player-a');
    expect(JSON.parse(values.get(pendingKey('player-a'))!).fighterId).toBe(OTHER);
  });

  it('does not silently expire a debut after a week away', async () => {
    values.set(pendingKey('player-a'), JSON.stringify({ fighterId: FIGHTER, at: Date.now() - 30 * 86400_000 }));
    await syncOnboardingProgress('player-a');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(values.has(pendingKey('player-a'))).toBe(false);
  });

  it('saves an anonymous trial once after sign-in', async () => {
    rememberCompletedAuraTrial();
    await syncOnboardingProgress('player-a');
    await syncOnboardingProgress('player-a');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain('/api/onboarding/trial');
  });

  it('shares a pending recovery request between App and the Crew page', async () => {
    rememberCompletedAuraTrial();
    let respond!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }));
    const first = syncOnboardingProgress('player-a');
    const second = syncOnboardingProgress('player-a');
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    respond(new Response('{}'));
    await Promise.all([first, second]);
    expect(values.has('asf:onboarding:trial-completed')).toBe(false);
  });

  it('still retries the valuable debut when trial sync fails', async () => {
    rememberCompletedAuraTrial();
    values.set(pendingKey('player-a'), JSON.stringify({ fighterId: FIGHTER, at: Date.now() }));
    fetchMock.mockImplementation(async (url: string) => new Response('{}', { status: url.endsWith('/trial') ? 503 : 200 }));
    await expect(syncOnboardingProgress('player-a')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(values.has(pendingKey('player-a'))).toBe(false);
    expect(values.has('asf:onboarding:trial-completed')).toBe(true);
  });

  it('ignores corrupt or future-dated local progress', async () => {
    values.set('asf:onboarding:trial-completed', String(Date.now() + 86400_000));
    values.set(pendingKey('player-a'), JSON.stringify({ fighterId: 'not-a-fighter', at: Date.now() }));
    await syncOnboardingProgress('player-a');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains progress if the account changes during a save', async () => {
    fetchMock.mockImplementationOnce(async () => {
      configureApiAuth(async () => 'different-account');
      return new Response('{}');
    });
    await expect(recordDebutWithRecovery(FIGHTER, 'player-a')).rejects.toThrow('account changed');
    expect(values.has(pendingKey('player-a'))).toBe(true);
  });

  it('rejects status if the account changes while the response body is read', async () => {
    const response = new Response();
    vi.spyOn(response, 'json').mockImplementation(async () => {
      configureApiAuth(async () => 'different-account');
      return { complete: true };
    });
    fetchMock.mockResolvedValueOnce(response);
    await expect(loadOnboardingStatus()).rejects.toThrow('account changed');
  });

  it.each([
    ['invitation lookup', () => loadReferralLanding('invite-id')],
    ['invitation creation', () => createCrewInviteLink()],
    ['invitation acceptance', () => acceptCrewInviteLink('invite-id')],
  ])('bounds a stalled %s and aborts its request', async (_name, action) => {
    vi.useFakeTimers();
    let requestSignal!: AbortSignal;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise(() => {});
    });
    const result = action();
    const rejected = expect(result).rejects.toBeInstanceOf(ApiRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(requestSignal.aborted).toBe(true);
  });
});
