import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useId: () => 'challenge-editor',
  useState: (initial: any) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [hooks.slots[index].value, (update: any) => {
      const value = typeof update === 'function' ? update(hooks.slots[index].value) : update;
      if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.dirty = true; }
    }];
  },
  useRef: (initial: any) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial }; },
  useMemo: (factory: () => unknown, deps: unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.slots[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.value;
    const value = factory(); hooks.slots[index] = { deps, value }; return value;
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.slots[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    const slot = { deps, cleanup: undefined as void | (() => void) }; hooks.slots[index] = slot;
    hooks.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); });
  },
}));
vi.mock('../shared/auraChallengeShare.ts', async original => ({ ...await original<typeof import('../shared/auraChallengeShare.ts')>(), shareAuraChallenge: vi.fn() }));
vi.mock('../shared/communityShare.ts', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../shared/auraChallenges.ts', () => ({ rememberAuraChallenge: vi.fn() }));
vi.mock('../../services/ProductEvents.ts', () => ({ trackProductEvent: vi.fn() }));

import { AuraChallengeComposer } from './AuraChallengeComposer.tsx';
import { AuraClipComposer } from './AuraClipComposer.tsx';
import { createAuraChallengeRoutine, decodeAuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../../game/aura/AuraTracks.ts';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';
import { copyToClipboard } from '../shared/communityShare.ts';
import { rememberAuraChallenge } from '../shared/auraChallenges.ts';

let props: Parameters<typeof AuraChallengeComposer>[0];
let tree: ReactNode;
const nodes = (node: any = tree): any[] => {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(child => nodes(child ?? null));
  if (typeof node !== 'object') return [];
  return [node, ...nodes(node.props?.children ?? null)];
};
const find = (predicate: (node: any) => boolean) => nodes().find(predicate);
const button = (text: string) => find(node => node.type === 'button' && node.props.children === text);
const editor = () => find(node => node.props?.className === 'aura-challenge-composer__editor');
const publisher = () => find(node => node.type === AuraClipComposer);
const flush = () => {
  let renders = 0;
  do {
    if (++renders > 20) throw new Error('Hook loop');
    hooks.dirty = false; hooks.cursor = 0; tree = AuraChallengeComposer(props);
    for (const effect of hooks.effects.splice(0)) effect();
  } while (hooks.dirty);
};
const settle = async () => { for (let i = 0; i < 15; i += 1) { await Promise.resolve(); flush(); } };

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false;
  vi.clearAllMocks();
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai');
  vi.stubGlobal('window', { location: { origin: 'https://insertplayer.ai' } });
  props = {
    routine: createAuraChallengeRoutine(34, 'lowkey', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!,
    scores: [{ slot: 0, name: 'Alex', score: 1200 }, { slot: 1, name: 'Sam', score: 800 }],
    recording: new File(['abc'], 'battle.mp4', { type: 'video/mp4' }), compact: true,
    onCreated: vi.fn(), onDraftChange: vi.fn(),
  };
  vi.mocked(shareAuraChallenge).mockResolvedValue('shared');
  vi.mocked(copyToClipboard).mockResolvedValue(true);
});
afterEach(() => { for (const slot of hooks.slots) slot?.cleanup?.(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('compact result challenge options', () => {
  it('keeps publishing first and hides editing and score-only sharing behind one plain control', () => {
    flush();
    expect(nodes().filter(node => node.type === 'details' || node.type === 'summary')).toEqual([]);
    expect(publisher().props).toMatchObject({ compact: true, file: props.recording });
    expect(nodes().indexOf(publisher())).toBeLessThan(nodes().indexOf(button('Edit challenge')));
    expect(button('Edit challenge').props).toMatchObject({ 'aria-expanded': false, 'aria-controls': editor().props.id });
    expect(editor().props.hidden).toBe(true);
    expect(nodes(editor()).some(node => node.type === 'button' && node.props.children === 'Share challenge only')).toBe(true);
    expect(shareAuraChallenge).not.toHaveBeenCalled();
    expect(rememberAuraChallenge).not.toHaveBeenCalled();
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it('edits the actual draft and preserves the publisher when the editor is closed', () => {
    flush(); button('Edit challenge').props.onClick(); flush();
    expect(editor().props.hidden).toBe(false);
    find(node => node.type === 'input' && !node.props.readOnly).props.onChange({ target: { value: 'New name' } }); flush();
    expect(publisher().props.challenge).toMatchObject({ name: 'New name', score: 1200, slot: 0 });
    find(node => node.type === 'select').props.onChange({ target: { value: '1' } }); flush();
    expect(publisher().props.challenge).toMatchObject({ name: 'Sam', score: 800, slot: 1 });
    button('Done editing').props.onClick(); flush();
    expect(editor().props.hidden).toBe(true);
    expect(publisher().props.file).toBe(props.recording);
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it('keeps upload-locked identity fields immutable without hiding score-only sharing', () => {
    flush(); publisher().props.onLockChange(true); flush();
    button('Edit challenge').props.onClick(); flush();
    expect(find(node => node.type === 'select').props.disabled).toBe(true);
    expect(find(node => node.type === 'input' && !node.props.readOnly).props.disabled).toBe(true);
    expect(button('Share challenge only').props.disabled).toBe(false);
  });

  it('shares only after a chosen score-only action and keeps a manual link visible after closing editing', async () => {
    vi.mocked(shareAuraChallenge).mockResolvedValue('manual');
    flush(); button('Edit challenge').props.onClick(); flush();
    button('Share challenge only').props.onClick(); await settle();
    expect(shareAuraChallenge).toHaveBeenCalledOnce();
    expect(props.onCreated).toHaveBeenCalledOnce();
    button('Done editing').props.onClick(); flush();
    const manual = find(node => node.type === 'input' && node.props.readOnly);
    const sharedUrl = vi.mocked(shareAuraChallenge).mock.calls[0][0].url;
    expect(manual.props.value).toBe(sharedUrl);
    const publicUrl = new URL(sharedUrl);
    expect(publicUrl.origin).toBe('https://api.insertplayer.ai');
    expect(publicUrl.pathname).toMatch(/^\/challenges\/aura\//);
    expect(decodeAuraChallenge(publicUrl.pathname.split('/').at(-1))).toMatchObject({
      ok: true, challenge: { name: 'Alex', score: 1200, slot: 0 },
    });
    expect(nodes(editor())).not.toContain(manual);
    expect(publisher().props.file).toBe(props.recording);
  });

  it('keeps explicit copying available when the result has no recording', async () => {
    props.recording = null; flush();
    expect(publisher()).toBeUndefined();
    expect(button('Share this challenge')).toBeTruthy();
    expect(editor().props.hidden).toBe(true);
    button('Edit challenge').props.onClick(); flush();
    button('Copy challenge link').props.onClick(); await settle();
    expect(copyToClipboard).toHaveBeenCalledOnce();
    expect(shareAuraChallenge).not.toHaveBeenCalled();
  });

  it('keeps full-page editing and the existing score-only fallback available', () => {
    props.compact = false; flush();
    expect(button('Edit challenge')).toBeUndefined();
    expect(find(node => node.props?.className === 'aura-challenge-composer__identity').props.hidden).toBeUndefined();
    expect(find(node => node.type === 'summary').props.children).toBe('Share the score without video');
    expect(button('Share challenge only')).toBeTruthy();
  });
});
