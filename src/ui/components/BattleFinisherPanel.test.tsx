import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: any) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks.slots[index].value, (update: any) => { const value = typeof update === 'function' ? update(hooks.slots[index].value) : update; if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.dirty = true; } }]; },
  useRef: (initial: any) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial }; },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => { const index = hooks.cursor++; const previous = hooks.slots[index]; if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; const slot = { deps, cleanup: undefined as void | (() => void) }; hooks.slots[index] = slot; hooks.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect(); }); },
}));
vi.mock('../../services/BattleFinishers.ts', async original => ({ ...await original<typeof import('../../services/BattleFinishers.ts')>(), saveBattleCapture: vi.fn(), generateBattleFinisher: vi.fn(), publishSavedBattle: vi.fn(), getSavedBattle: vi.fn() }));
vi.mock('../shared/battleDrafts.ts', () => ({ saveBattleDraft: vi.fn(), removeBattleDraft: vi.fn(), battleFinisherRequestId: vi.fn(() => '00000000-0000-4000-8000-000000000099') }));
vi.mock('../shared/auraChallengeShare.ts', () => ({ shareAuraChallenge: vi.fn() }));
import { BattleFinisherPanel, type BattleFinisherPanelProps } from './BattleFinisherPanel.tsx';
import { BattleFinisherError, generateBattleFinisher, getSavedBattle, publishSavedBattle, saveBattleCapture, type SavedBattle } from '../../services/BattleFinishers.ts';
import { saveBattleDraft } from '../shared/battleDrafts.ts';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';
const id = 'a'.repeat(32);
const battle: SavedBattle = { id, summary: { game: 'aura', winner: 'p1', p1Name: 'Trump', p2Name: 'Lamine', stageLabel: 'Plaza', durationSeconds: 80 }, published: false, isOwner: true, createdAt: '2026-09-11T18:00:00Z', stillUrl: `https://api.insertplayer.ai/api/battles/${id}/still`, shareUrl: `https://insertplayer.ai/battles/${id}`, finisherShareUrl: `https://insertplayer.ai/battles/${id}/finisher`, ogImageUrl: `https://api.insertplayer.ai/share/battles/${id}/og.png` };
const queued: SavedBattle = { ...battle, finisher: { id: 'job', status: 'queued', creditRefunded: false } };
let props: BattleFinisherPanelProps; let tree: ReactNode;
const find = (predicate: (node: any) => boolean, node: any = tree): any => { if (!node) return; if (Array.isArray(node)) return node.map(child => child === undefined ? undefined : find(predicate, child)).find(Boolean); if (typeof node !== 'object') return; return predicate(node) ? node : node.props?.children === undefined ? undefined : find(predicate, node.props.children); };
const button = (label: string) => find(node => node.type === 'button' && node.props.children === label);
const flush = () => { let renders = 0; do { if (++renders > 30) throw Error('Hook loop'); hooks.dirty = false; hooks.cursor = 0; tree = BattleFinisherPanel(props); for (const effect of hooks.effects.splice(0)) effect(); } while (hooks.dirty); };
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flush(); } };
const expand = () => { button('Fatality · 1 credit').props.onClick(); flush(); };
const consent = () => { find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); flush(); };
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false; vi.clearAllMocks();
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), location: { href: 'https://insertplayer.ai/aura' } });
  props = { capture: { clientBattleId: '00000000-0000-4000-8000-000000000001', summary: battle.summary, stillBase64: '/9j/AA==' }, authStatus: 'signed-in', authSessionKey: 'owner', onSignIn: vi.fn(), onBuyCredits: vi.fn() };
  vi.mocked(saveBattleDraft).mockResolvedValue(true); vi.mocked(saveBattleCapture).mockResolvedValue(battle); vi.mocked(generateBattleFinisher).mockResolvedValue(queued); vi.mocked(getSavedBattle).mockResolvedValue(battle); vi.mocked(publishSavedBattle).mockResolvedValue({ ...battle, published: true }); vi.mocked(shareAuraChallenge).mockResolvedValue('copied');
});
afterEach(() => { for (const slot of hooks.slots) slot?.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('optional finisher flow', () => {
  it('starts with a compact offer and never saves remotely, spends or publishes on render', async () => {
    flush(); await settle(); expect(button('Fatality · 1 credit')).toBeTruthy();
    expect(button('Fatality · 1 credit').props.className).toContain('asf-btn--primary');
    expect(button('Fatality · 1 credit').props['aria-expanded']).toBe(false);
    expect(find(node => node.type === 'input')).toBeUndefined(); expect(saveBattleCapture).not.toHaveBeenCalled(); expect(generateBattleFinisher).not.toHaveBeenCalled(); expect(publishSavedBattle).not.toHaveBeenCalled();
    expand(); expect(button('Generate fatality · 1 credit').props.disabled).toBe(true);
    expect(find(node => node.type === 'details')?.props.open).not.toBe(true);
  });
  it.each([
    ['queued', 'Fatality queued'],
    ['generating', 'Creating fatality…'],
    ['ready', 'Watch fatality'],
    ['failed', 'Retry fatality · 1 credit'],
  ] as const)('makes the %s status clear without creating another job', async (status, label) => {
    const saved: SavedBattle = { ...battle, finisher: { id: 'existing-job', status, creditRefunded: status === 'failed' } };
    props = { ...props, capture: null, battleId: id, initialBattle: saved };
    vi.mocked(getSavedBattle).mockResolvedValue(saved);
    flush(); await settle();
    expect(button(label)).toBeTruthy();
    expect(button('Fatality · 1 credit')).toBeUndefined();
    expect(find(node => node.props?.role === 'status')).toBeTruthy();
    expect(generateBattleFinisher).not.toHaveBeenCalled();
    expect(publishSavedBattle).not.toHaveBeenCalled();
  });
  it('requires consent and one explicit click; double clicks cannot create two paid jobs', async () => {
    let resolve!: (value: SavedBattle) => void; vi.mocked(generateBattleFinisher).mockImplementation(() => new Promise(done => { resolve = done; }));
    flush(); expand(); consent(); const generate = button('Generate fatality · 1 credit'); generate.props.onClick(); generate.props.onClick(); await settle();
    expect(saveBattleCapture).toHaveBeenCalledTimes(1); expect(generateBattleFinisher).toHaveBeenCalledTimes(1); expect(publishSavedBattle).not.toHaveBeenCalled();
    expect(vi.mocked(generateBattleFinisher).mock.calls[0][2]).toMatchObject({ ageConfirmed: true, photoRightsConfirmed: true, immediatePerformanceConfirmed: true });
    vi.mocked(getSavedBattle).mockResolvedValue(queued); resolve(queued); await settle(); expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'insert-player-billing-changed' }));
  });
  it('can collapse and reopen an in-flight generation without starting another one', async () => {
    let resolve!: (value: SavedBattle) => void;
    vi.mocked(generateBattleFinisher).mockImplementation(() => new Promise(done => { resolve = done; }));
    flush(); expand(); consent(); button('Generate fatality · 1 credit').props.onClick(); await settle();
    button('Close').props.onClick(); flush(); expect(button('Preparing fatality…')).toBeTruthy();
    button('Preparing fatality…').props.onClick(); flush();
    expect(button('Preparing fatality…').props.disabled).toBe(true);
    expect(generateBattleFinisher).toHaveBeenCalledTimes(1);
    vi.mocked(getSavedBattle).mockResolvedValue(queued); resolve(queued); await settle();
    expect(generateBattleFinisher).toHaveBeenCalledTimes(1);
  });
  it('keeps the same request id after a lost generation response instead of making a new purchase intent', async () => {
    vi.mocked(generateBattleFinisher).mockRejectedValueOnce(Error('Connection lost'));
    flush(); expand(); consent(); button('Generate fatality · 1 credit').props.onClick(); await settle();
    button('Generate fatality · 1 credit').props.onClick(); await settle();
    expect(vi.mocked(generateBattleFinisher).mock.calls[1][1]).toBe(vi.mocked(generateBattleFinisher).mock.calls[0][1]);
  });
  it('persists the draft before handing off to sign-in and never charges automatically afterward', async () => {
    props.authStatus = 'signed-out'; props.authSessionKey = 'signed-out'; flush(); expand();
    button('Sign in for your fatality').props.onClick(); await settle(); expect(props.onSignIn).toHaveBeenCalledTimes(1); expect(saveBattleDraft).toHaveBeenCalled();
    props = { ...props, authStatus: 'signed-in', authSessionKey: 'new-owner' }; flush(); await settle();
    expect(generateBattleFinisher).not.toHaveBeenCalled(); expect(button('Generate fatality · 1 credit').props.disabled).toBe(true);
  });
  it('keeps a saved battle and offers credits on402 without trying a second generation', async () => {
    vi.mocked(generateBattleFinisher).mockRejectedValue(new BattleFinisherError('Need1credit', 402));
    flush(); expand(); consent(); button('Generate fatality · 1 credit').props.onClick(); await settle();
    expect(button('Get credits')).toBeTruthy(); button('Get credits').props.onClick(); await settle(); expect(props.onBuyCredits).toHaveBeenCalledTimes(1); expect(generateBattleFinisher).toHaveBeenCalledTimes(1);
  });
  it('recovers a pending job after reload through GET polling without sending a paid POST', async () => {
    props = { ...props, capture: null, battleId: id, initialBattle: queued }; vi.mocked(getSavedBattle).mockResolvedValue(queued);
    flush(); await settle(); expect(button('Fatality queued')).toBeTruthy(); expect(getSavedBattle).toHaveBeenCalled(); expect(generateBattleFinisher).not.toHaveBeenCalled();
  });
  it('publishes only after the explicit share action, and shares a branded page URL', async () => {
    props = { ...props, capture: null, battleId: id, initialBattle: battle }; flush(); await settle(); expand();
    expect(publishSavedBattle).not.toHaveBeenCalled(); button('Publish & share battle').props.onClick(); await settle();
    expect(publishSavedBattle).toHaveBeenCalledTimes(1); expect(shareAuraChallenge).toHaveBeenCalledWith(expect.objectContaining({ url: battle.shareUrl })); expect(generateBattleFinisher).not.toHaveBeenCalled();
  });
  it('does not transfer a signed-in account’s final frame when the account changes', async () => {
    flush(); await settle(); vi.mocked(saveBattleDraft).mockClear(); props = { ...props, authSessionKey: 'different-owner' }; flush(); await settle();
    expect(tree).toBeNull(); expect(saveBattleDraft).not.toHaveBeenCalled(); expect(saveBattleCapture).not.toHaveBeenCalled();
  });
  it('claims a guest capture for the first saving account and hides it from a later account', async () => {
    props = { ...props, authStatus: 'signed-out', authSessionKey: 'signed-out' }; flush(); expand();
    props = { ...props, authStatus: 'signed-in', authSessionKey: 'owner-a' }; flush();
    button('Save battle free').props.onClick(); await settle(); expect(saveBattleCapture).toHaveBeenCalledTimes(1);
    vi.mocked(saveBattleDraft).mockClear(); props = { ...props, authSessionKey: 'owner-b' }; flush(); await settle();
    expect(tree).toBeNull(); expect(saveBattleDraft).not.toHaveBeenCalled();
  });
});
