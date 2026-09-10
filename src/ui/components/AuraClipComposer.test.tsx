import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [hooks.slots[index].value, (update: any) => {
      const value = typeof update === 'function' ? update(hooks.slots[index].value) : update;
      if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.dirty = true; }
    }];
  },
  useRef: (initial: any) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial }; },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.slots[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    const slot = { deps, cleanup: undefined as void | (() => void) }; hooks.slots[index] = slot;
    hooks.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
  },
}));
vi.mock('../../services/AuraClips.ts', async original => ({ ...await original<typeof import('../../services/AuraClips.ts')>(),
  hasAuthenticatedAuraClipSession: vi.fn(), prepareAuraClip: vi.fn(), uploadAuraClip: vi.fn(), getAuraClip: vi.fn(), rememberAuraClipOwner: vi.fn() }));
vi.mock('../shared/auraChallengeShare.ts', () => ({ shareAuraChallenge: vi.fn() }));
vi.mock('../shared/auraChallenges.ts', () => ({ rememberAuraChallenge: vi.fn() }));
vi.mock('../../services/ProductEvents.ts', () => ({ trackProductEvent: vi.fn() }));
import { AuraClipComposer } from './AuraClipComposer.tsx';
import { TurnstileChallenge } from './TurnstileChallenge.tsx';
import { AuraClipError, getAuraClip, hasAuthenticatedAuraClipSession, prepareAuraClip, rememberAuraClipOwner, uploadAuraClip, type AuraClip, type AuraClipUpload } from '../../services/AuraClips.ts';
import { createAuraChallenge, createAuraChallengeRoutine } from '../../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../../game/aura/AuraTracks.ts';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';
const id = 'a'.repeat(32);
const intent: AuraClipUpload = { id, uploadToken: 'upload-secret', deleteToken: 'delete-secret', expiresAt: '2026-09-11T12:15:00Z', uploadUrl: `https://api.insertplayer.ai/api/aura/clips/${id}/video` };
const clip: AuraClip = { id, challengeToken: 'challenge', shareUrl: `https://insertplayer.ai/watch/${id}`, videoUrl: intent.uploadUrl,
  downloadUrl: intent.uploadUrl + '?download=1', ogImageUrl: 'https://api.insertplayer.ai/og.png', createdAt: '2026-09-11T12:00:00Z', expiresAt: '2026-10-11T12:00:00Z', contentType: 'video/mp4', byteLength: 3 };
let props: Parameters<typeof AuraClipComposer>[0];
let tree: ReactNode;
const find = (predicate: (node: any) => boolean, node: any = tree): any => {
  if (!node) return undefined;
  if (Array.isArray(node)) return node.map(child => find(predicate, child)).find(Boolean);
  if (typeof node !== 'object') return undefined;
  return predicate(node) ? node : find(predicate, node.props?.children);
};
const button = (text: string) => find(node => node.type === 'button' && node.props.children === text);
const flush = () => {
  let renders = 0;
  do {
    if (++renders > 20) throw new Error('Hook loop');
    hooks.dirty = false; hooks.cursor = 0; tree = AuraClipComposer(props);
    for (const effect of hooks.effects.splice(0)) effect();
  } while (hooks.dirty);
};
const settle = async () => { for (let i = 0; i < 15; i += 1) { await Promise.resolve(); flush(); } };
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false;
  vi.clearAllMocks(); vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
  const routine = createAuraChallengeRoutine(34, 'lowkey', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!;
  props = { file: new File(['abc'], 'battle.mp4', { type: 'video/mp4' }), challenge: createAuraChallenge(routine, 'Alex', 1200), onCreated: vi.fn(), onLockChange: vi.fn() };
  vi.mocked(hasAuthenticatedAuraClipSession).mockResolvedValue(false);
  vi.mocked(prepareAuraClip).mockResolvedValue(intent);
  vi.mocked(uploadAuraClip).mockResolvedValue(clip);
  vi.mocked(getAuraClip).mockResolvedValue(clip);
  vi.mocked(shareAuraChallenge).mockResolvedValue('shared');
});
afterEach(() => {
  for (const slot of hooks.slots) slot?.cleanup?.();
  vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('explicit hosted battle publishing', () => {
  it('never uploads on mount, ignores double clicks, and waits for a new click to open native URL share', async () => {
    let finish!: (value: AuraClip) => void;
    vi.mocked(uploadAuraClip).mockImplementation((_file, _intent, progress) => { progress(40); return new Promise(resolve => { finish = resolve; }); });
    flush(); expect(prepareAuraClip).not.toHaveBeenCalled();
    const create = button('Create battle link'); create.props.onClick(); create.props.onClick(); await settle();
    expect(prepareAuraClip).toHaveBeenCalledTimes(1); expect(uploadAuraClip).toHaveBeenCalledTimes(1);
    expect(find(node => node.type === 'progress')?.props.value).toBe(40);
    expect(shareAuraChallenge).not.toHaveBeenCalled();
    finish(clip); await settle();
    expect(button('Share battle link')).toBeTruthy();
    expect(rememberAuraClipOwner).toHaveBeenLastCalledWith(id, 'delete-secret', clip.expiresAt);
    expect(props.onCreated).toHaveBeenCalledTimes(1);
    button('Share battle link').props.onClick(); await settle();
    expect(shareAuraChallenge).toHaveBeenCalledWith(expect.objectContaining({ url: clip.shareUrl }));
    expect(shareAuraChallenge).not.toHaveBeenCalledWith(expect.objectContaining({ files: expect.anything() }));
  });
  it('opens guest verification only after publish click and uses the aura_share action', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key'); flush();
    expect(find(node => node.type === TurnstileChallenge)).toBeUndefined();
    button('Create battle link').props.onClick(); await settle();
    const verification = find(node => node.type === TurnstileChallenge);
    expect(verification.props.action).toBe('aura_share'); expect(prepareAuraClip).not.toHaveBeenCalled();
    verification.props.onTokenChange('verified'); await settle();
    expect(prepareAuraClip).toHaveBeenCalledWith(props.file, expect.any(String), 'verified');
  });
  it('recovers the existing ready clip after losing the upload response, without reserving or uploading again', async () => {
    vi.mocked(uploadAuraClip).mockRejectedValueOnce(new Error('Network lost')); flush();
    button('Create battle link').props.onClick(); await settle();
    expect(button('Retry publishing')).toBeTruthy(); button('Retry publishing').props.onClick(); await settle();
    expect(getAuraClip).toHaveBeenCalledWith(id, expect.any(AbortSignal), 'upload-secret');
    expect(prepareAuraClip).toHaveBeenCalledTimes(1); expect(uploadAuraClip).toHaveBeenCalledTimes(1);
    expect(button('Share battle link')).toBeTruthy();
  });
  it('reuses a pending reservation and its bytes after an interrupted upload', async () => {
    vi.mocked(uploadAuraClip).mockRejectedValueOnce(new Error('Network lost')).mockResolvedValueOnce(clip);
    vi.mocked(getAuraClip).mockRejectedValueOnce(new AuraClipError('Pending', 409, 'clip_pending'));
    flush(); button('Create battle link').props.onClick(); await settle();
    button('Retry publishing').props.onClick(); await settle();
    expect(prepareAuraClip).toHaveBeenCalledTimes(1); expect(uploadAuraClip).toHaveBeenCalledTimes(2);
    expect(uploadAuraClip).toHaveBeenLastCalledWith(props.file, intent, expect.any(Function), expect.any(AbortSignal));
    expect(button('Share battle link')).toBeTruthy();
  });
  it('keeps the ready link after native share cancellation', async () => {
    vi.mocked(shareAuraChallenge).mockResolvedValue('cancelled'); flush(); button('Create battle link').props.onClick(); await settle();
    button('Share battle link').props.onClick(); await settle();
    expect(button('Share battle link')).toBeTruthy(); expect(button('Copy battle link')).toBeTruthy();
    expect(prepareAuraClip).toHaveBeenCalledTimes(1);
  });
  it('publishes directly for an already authenticated creator without mounting Turnstile', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
    vi.mocked(hasAuthenticatedAuraClipSession).mockResolvedValue(true);
    flush(); button('Create battle link').props.onClick(); await settle();
    expect(hasAuthenticatedAuraClipSession).toHaveBeenCalledTimes(1);
    expect(find(node => node.type === TurnstileChallenge)).toBeUndefined();
    expect(prepareAuraClip).toHaveBeenCalledWith(props.file, expect.any(String), undefined);
    expect(button('Share battle link')).toBeTruthy();
  });
  it('recreates a failed reservation in the same retry when no new guest verification is needed', async () => {
    vi.mocked(uploadAuraClip).mockRejectedValueOnce(new Error('Network lost')).mockResolvedValueOnce(clip);
    vi.mocked(getAuraClip).mockRejectedValueOnce(new AuraClipError('Unavailable', 404));
    flush(); button('Create battle link').props.onClick(); await settle();
    button('Retry publishing').props.onClick(); await settle();
    expect(prepareAuraClip).toHaveBeenCalledTimes(2); expect(uploadAuraClip).toHaveBeenCalledTimes(2);
    expect(button('Share battle link')).toBeTruthy();
  });
  it('re-verifies a guest within the same retry while retaining the recording and chosen challenge', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
    vi.mocked(uploadAuraClip).mockRejectedValueOnce(new Error('Network lost')).mockResolvedValueOnce(clip);
    vi.mocked(getAuraClip).mockRejectedValueOnce(new AuraClipError('Unavailable', 404));
    flush(); button('Create battle link').props.onClick(); await settle();
    find(node => node.type === TurnstileChallenge).props.onTokenChange('first-verification'); await settle();
    button('Retry publishing').props.onClick(); await settle();
    const retry = find(node => node.type === TurnstileChallenge);
    expect(retry.props.action).toBe('aura_share');
    retry.props.onTokenChange('fresh-verification'); await settle();
    expect(prepareAuraClip).toHaveBeenLastCalledWith(props.file, expect.any(String), 'fresh-verification');
    expect(button('Share battle link')).toBeTruthy();
  });

});
