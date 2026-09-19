import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock('react', async (original) => {
  const memo = (factory: () => unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
    hooks.slots[index] = { deps, value: factory() };
    return hooks.slots[index].value;
  };
  return {
    ...await original<typeof import('react')>(),
    useState: (initial: any) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks.slots[index].value, (update: any) => {
        const value = typeof update === 'function' ? update(hooks.slots[index].value) : update;
        if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.dirty = true; }
      }];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
    useRef: (initial: unknown) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial }; },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.slots[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      const slot = { deps, cleanup: undefined as void | (() => void) };
      hooks.slots[index] = slot;
      hooks.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
    },
  };
});
vi.mock('../../services/Crews.ts', () => ({
  acceptCrewInviteLink: vi.fn(), loadReferralLanding: vi.fn(), createCrewInviteLink: vi.fn(),
  loadOnboardingStatus: vi.fn(), shareFighterWithActiveCrew: vi.fn(), syncOnboardingProgress: vi.fn(),
}));
vi.mock('../../services/Billing.ts', () => ({ loadBillingProfile: vi.fn() }));
vi.mock('../../services/CloudFighters.ts', () => ({ listCloudFighters: vi.fn() }));
vi.mock('../../services/ProductEvents.ts', () => ({ trackProductEvent: vi.fn() }));

import { CrewJoinPage } from './CrewJoinPage.tsx';
import { CrewOnboardingPage } from './CrewOnboardingPage.tsx';
import { Button } from '../components/Button.tsx';
import {
  acceptCrewInviteLink, createCrewInviteLink, loadOnboardingStatus, loadReferralLanding,
  shareFighterWithActiveCrew, syncOnboardingProgress, type OnboardingStatus, type ReferralLanding,
} from '../../services/Crews.ts';
import { loadBillingProfile } from '../../services/Billing.ts';
import { listCloudFighters } from '../../services/CloudFighters.ts';
import { trackProductEvent } from '../../services/ProductEvents.ts';

const crew = { id: 'org_alpha', name: 'Alpha Crew', slug: 'alpha' };
const invitation: ReferralLanding = {
  id: 'a'.repeat(32), organizationId: crew.id, crewName: crew.name, inviterName: 'Player One',
  status: 'pending', inviteChannel: 'link',
};
const freshLink = {
  id: 'b'.repeat(32), status: 'pending' as const, expiresAt: '2099-01-01T00:00:00Z',
  url: `https://insertplayer.ai/join?referral=${'b'.repeat(32)}`,
};
const completedStatus: OnboardingStatus = {
  trialComplete: true, debutComplete: true,
  fighter: { id: 'f'.repeat(32), photoHash: 'player-photo', name: 'Player Rookie' },
  activeCrew: { id: crew.id, slug: crew.slug, role: 'org:admin' },
  invitesSent: 1, invitesAccepted: 1, pendingInvite: null, sharedWithActiveCrew: true, canInviteCrew: true,
  crewStage: { id: 's'.repeat(32), label: 'THE PARK', kind: 'photo', createdAt: '2026-09-01' },
  crewStageState: 'ready', crewStageReady: true, referralRookiePasses: 0, recommendedStep: 'complete', complete: true,
};

let tree: ReactNode;
let renderPage: () => ReactNode;
let joinProps: ComponentProps<typeof CrewJoinPage>;
let onboardingProps: ComponentProps<typeof CrewOnboardingPage>;
let shareWindow: { opener: unknown; location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> };

function find(predicate: (node: any) => boolean, node: any = tree): any {
  if (!node) return;
  if (Array.isArray(node)) return node.map((child) => find(predicate, child)).find(Boolean);
  if (typeof node !== 'object') return;
  return predicate(node) ? node : find(predicate, node.props?.children);
}
function textContent(node: any = tree): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return textContent(node.props?.children);
}
function button(label: string): any {
  return find((node) => node.type === Button && textContent(node) === label);
}
function progress(label: string): string {
  const row = find((node) => node.type === 'div' && Array.isArray(node.props.children)
    && node.props.children.some((child: any) => child?.type === 'dt' && textContent(child).startsWith(label)));
  return textContent(find((node) => node.type === 'dd', row));
}
function flush(): void {
  let renders = 0;
  do {
    if (++renders > 30) throw new Error('Hook loop');
    hooks.dirty = false; hooks.cursor = 0;
    tree = renderPage();
    for (const effect of hooks.effects.splice(0)) effect();
  } while (hooks.dirty);
}
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) { await Promise.resolve(); flush(); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false;
  vi.resetAllMocks();
  shareWindow = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
  vi.stubGlobal('window', {
    open: vi.fn(() => shareWindow), location: { assign: vi.fn() },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  joinProps = {
    referralId: invitation.id, authStatus: 'signed-in', activeCrew: null, crews: [],
    onSelectCrew: vi.fn().mockResolvedValue(undefined), onCreateRookie: vi.fn(), onPlayCrew: vi.fn(), onBack: vi.fn(),
  };
  onboardingProps = {
    authStatus: 'signed-in', authSessionKey: 'player-session', playerName: 'Player One', activeCrew: crew,
    crews: [{ ...crew, role: 'org:admin' }], onCreateFighter: vi.fn(), onPlayTrial: vi.fn(),
    onPlayDebut: vi.fn(), onCreateStage: vi.fn(), onComplete: vi.fn(),
  };
  vi.mocked(loadReferralLanding).mockResolvedValue(invitation);
  vi.mocked(acceptCrewInviteLink).mockResolvedValue(undefined);
  vi.mocked(loadBillingProfile).mockResolvedValue({ status: 'ready', profile: {
    creditsBalance: 0, freeRookieGenerationsUsed: 1, referralRookiePasses: 0, planTier: 'free',
  } });
  vi.mocked(loadOnboardingStatus).mockResolvedValue(completedStatus);
  vi.mocked(listCloudFighters).mockResolvedValue([]);
  vi.mocked(syncOnboardingProgress).mockResolvedValue(undefined);
  vi.mocked(createCrewInviteLink).mockResolvedValue(freshLink);
  renderPage = () => CrewJoinPage(joinProps);
});
afterEach(() => {
  for (const slot of hooks.slots) slot?.cleanup?.();
  vi.unstubAllGlobals();
});

describe('Crew invitation async interactions', () => {
  it('takes a returning player to Crew play without promising another free character', async () => {
    flush(); await settle();
    expect(button('Join Crew & Create My Included Rookie')).toBeUndefined();
    expect(button('Join Crew & Play')).toBeTruthy();
    button('Join Crew & Play').props.onClick(); await settle();
    expect(acceptCrewInviteLink).toHaveBeenCalledWith(invitation.id);
    expect(joinProps.onSelectCrew).toHaveBeenCalledWith(crew.id);
    expect(joinProps.onPlayCrew).toHaveBeenCalledTimes(1);
    expect(joinProps.onCreateRookie).not.toHaveBeenCalled();
  });

  it.each([{ used: 0, passes: 0 }, { used: 1, passes: 1 }])('offers an included Rookie only with real allowance: %j', async ({ used, passes }) => {
    vi.mocked(loadBillingProfile).mockResolvedValue({ status: 'ready', profile: {
      creditsBalance: 0, freeRookieGenerationsUsed: used, referralRookiePasses: passes, planTier: 'free',
    } });
    flush(); await settle();
    expect(button('Play With The Crew First')).toBeTruthy();
    button('Join Crew & Create My Included Rookie').props.onClick(); await settle();
    expect(acceptCrewInviteLink).toHaveBeenCalledTimes(1);
    expect(joinProps.onCreateRookie).toHaveBeenCalledTimes(1);
    expect(joinProps.onPlayCrew).not.toHaveBeenCalled();
  });

  it('revalidates a WhatsApp link for an already active member and preserves legacy email acceptance', async () => {
    joinProps = { ...joinProps, activeCrew: crew, crews: [{ ...crew, role: 'org:member' }] };
    flush(); await settle();
    button('Play With My Crew').props.onClick(); await settle();
    expect(acceptCrewInviteLink).toHaveBeenCalledTimes(1);
    expect(joinProps.onSelectCrew).not.toHaveBeenCalled();
  });

  it('does not send a legacy accepted email invite through the new link-only endpoint', async () => {
    vi.mocked(loadReferralLanding).mockResolvedValue({ ...invitation, inviteChannel: 'email', status: 'accepted' });
    joinProps = { ...joinProps, activeCrew: crew, crews: [{ ...crew, role: 'org:member' }] };
    flush(); await settle();
    button('Play With My Crew').props.onClick(); await settle();
    expect(acceptCrewInviteLink).not.toHaveBeenCalled();
    expect(joinProps.onPlayCrew).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed join on the invitation, shows the API error, and enables retry without navigating', async () => {
    const acceptance = deferred<void>();
    vi.mocked(acceptCrewInviteLink).mockReturnValue(acceptance.promise);
    flush(); await settle();
    button('Join Crew & Play').props.onClick(); flush();
    expect(button('Joining Crew…').props.disabled).toBe(true);
    acceptance.reject(new Error('This invite link has already been claimed'));
    await settle();
    expect(textContent()).toContain('This invite link has already been claimed');
    expect(button('Join Crew & Play').props.disabled).toBe(false);
    expect(joinProps.onSelectCrew).not.toHaveBeenCalled();
    expect(joinProps.onPlayCrew).not.toHaveBeenCalled();
    expect(joinProps.onCreateRookie).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalledWith('invite_accepted', expect.anything());
  });
});

describe('Crew mission async interactions', () => {
  beforeEach(() => { renderPage = () => CrewOnboardingPage(onboardingProps); });

  it('keeps WhatsApp available after completion and refreshes an expired or claimed cached link before sharing', async () => {
    const staleLink = { ...freshLink, id: 'old-link', expiresAt: '2020-01-01', url: 'https://insertplayer.ai/join?referral=old' };
    vi.mocked(loadOnboardingStatus).mockResolvedValue({ ...completedStatus, pendingInvite: staleLink });
    flush(); await settle();
    expect(textContent()).toContain('Crew Ready');
    expect(createCrewInviteLink).not.toHaveBeenCalled();
    button('Invite Another Player on WhatsApp').props.onClick(); await settle();
    expect(createCrewInviteLink).toHaveBeenCalledTimes(1);
    expect(shareWindow.opener).toBeNull();
    const destination = new URL(shareWindow.location.replace.mock.calls[0][0]);
    expect(destination.hostname).toBe('wa.me');
    expect(destination.searchParams.get('text')).toContain(freshLink.url);
    expect(destination.searchParams.get('text')).not.toContain(staleLink.url);
    expect(onboardingProps.onCreateStage).not.toHaveBeenCalled();
    expect(shareFighterWithActiveCrew).not.toHaveBeenCalled();
    expect(button('Invite Another Player on WhatsApp')).toBeTruthy();
  });

  it('refreshes the one-time link for every copy and does not mark an invitation accepted just by copying', async () => {
    vi.mocked(loadOnboardingStatus).mockResolvedValue({
      ...completedStatus, complete: false, invitesAccepted: 0, crewStageReady: false, crewStage: null,
      crewStageState: 'available', recommendedStep: 'invite',
    });
    flush(); await settle();
    button('Copy Invite Link').props.onClick(); await settle();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(freshLink.url);
    expect(progress('5 · Invite Player Two')).toBe('Waiting');
    expect(button('Choose Crew Stage · Included')).toBeUndefined();
    button('Copy Invite Link').props.onClick(); await settle();
    expect(createCrewInviteLink).toHaveBeenCalledTimes(2);
  });

  it('closes the provisional WhatsApp window when the API fails, keeps the current mission and allows retry', async () => {
    vi.mocked(createCrewInviteLink).mockRejectedValue(new Error('Invitation service unavailable'));
    flush(); await settle();
    button('Invite Another Player on WhatsApp').props.onClick(); await settle();
    expect(shareWindow.close).toHaveBeenCalledTimes(1);
    expect(shareWindow.location.replace).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(textContent()).toContain('Invitation service unavailable');
    expect(button('Invite Another Player on WhatsApp').props.disabled).toBe(false);
    expect(onboardingProps.onComplete).not.toHaveBeenCalled();
  });

  it('waits for account progress and marks only completed missions Done before the first owned-character match', async () => {
    const status = deferred<OnboardingStatus>();
    vi.mocked(loadOnboardingStatus).mockReturnValue(status.promise);
    flush(); await settle();
    expect(textContent()).toContain('Loading your next mission…');
    expect(button('Play My Aura Debut')).toBeUndefined();
    expect(progress('1 · Learn Aura')).not.toBe('Done');
    expect(progress('3 · Aura debut')).not.toBe('Done');
    status.resolve({
      ...completedStatus, trialComplete: false, debutComplete: false, sharedWithActiveCrew: false,
      invitesSent: 0, invitesAccepted: 0, crewStage: null, crewStageReady: false,
      crewStageState: 'available', recommendedStep: 'debut', complete: false,
    });
    await settle();
    expect(progress('1 · Learn Aura')).toBe('Optional');
    expect(progress('2 · Create your Rookie')).toBe('Done');
    expect(progress('3 · Aura debut')).toBe('Next');
    expect(progress('4 · Build a Crew')).not.toBe('Done');
    expect(progress('5 · Invite Player Two')).not.toBe('Done');
    expect(progress('6 · Choose a home stage')).not.toBe('Done');
    button('Play My Aura Debut').props.onClick();
    expect(onboardingProps.onPlayDebut).toHaveBeenCalledWith('player-photo');
    expect(syncOnboardingProgress).toHaveBeenCalledWith('player-session');
  });

  it('offers a retry after progress loading fails without inventing completion or navigating away', async () => {
    vi.mocked(loadOnboardingStatus).mockRejectedValueOnce(new Error('Progress unavailable'));
    flush(); await settle();
    expect(textContent()).toContain('Progress unavailable');
    expect(button('Enter Insert Player')).toBeUndefined();
    expect(onboardingProps.onComplete).not.toHaveBeenCalled();
    button('Retry Progress').props.onClick(); await settle();
    expect(button('Enter Insert Player')).toBeTruthy();
    expect(loadOnboardingStatus).toHaveBeenCalledTimes(2);
  });
});
