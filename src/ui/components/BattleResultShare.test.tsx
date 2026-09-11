import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const states = vi.hoisted(() => ({ values: [] as unknown[], cleanup: undefined as (() => void) | undefined }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (value: unknown) => [value, (next: unknown) => states.values.push(next)],
  useEffect: (effect: () => (() => void)) => { states.cleanup = effect(); },
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock('../../services/BattleFinishers.ts', async original => ({ ...await original<typeof import('../../services/BattleFinishers.ts')>(), publishSavedBattle: vi.fn() }));
vi.mock('../shared/auraChallengeShare.ts', () => ({ shareAuraChallenge: vi.fn() }));
import { BattleResultShare } from './BattleResultShare.tsx';
import { publishSavedBattle, type SavedBattle } from '../../services/BattleFinishers.ts';
import { shareAuraChallenge } from '../shared/auraChallengeShare.ts';
const id='a'.repeat(32);
const battle: SavedBattle={ id, summary:{game:'aura',winner:'p1',p1Name:'Trump',p2Name:'Lamine',stageLabel:'Plaza',durationSeconds:51.5}, createdAt:'2026-09-11', published:false,isOwner:true,stillUrl:`https://api.insertplayer.ai/api/battles/${id}/still`,shareUrl:`https://insertplayer.ai/battles/${id}`,finisherShareUrl:`https://insertplayer.ai/battles/${id}/finisher`,ogImageUrl:`https://api.insertplayer.ai/share/battles/${id}/og.png`,finisher:{id:'job',status:'ready',creditRefunded:false,videoUrl:`https://api.insertplayer.ai/api/battles/${id}/finisher`}};
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve()};
beforeEach(()=>{vi.clearAllMocks();states.values=[];vi.stubGlobal('window',{location:{href:'https://insertplayer.ai/aura'}});vi.mocked(publishSavedBattle).mockResolvedValue({...battle,published:true});vi.mocked(shareAuraChallenge).mockResolvedValue('copied')});
afterEach(()=>vi.unstubAllGlobals());
describe('main battle-result share',()=>{
 it('publishes once on an explicit click, then shares the permanent battle page including the finale',async()=>{
  const onBattleChange=vi.fn(); const tree=BattleResultShare({battle,onBattleChange});
  expect(publishSavedBattle).not.toHaveBeenCalled();
  const button=tree.props.children[0]; expect(button.props.children).toBe('Publish & share battle + finale');
  button.props.onClick();button.props.onClick();await settle();
  expect(publishSavedBattle).toHaveBeenCalledTimes(1);expect(onBattleChange).toHaveBeenCalledWith({...battle,published:true});
  expect(shareAuraChallenge).toHaveBeenCalledWith(expect.objectContaining({url:battle.shareUrl}));
  expect(shareAuraChallenge).not.toHaveBeenCalledWith(expect.objectContaining({url:battle.finisher!.videoUrl}));
 });
 it('cannot attach or share an old battle after its result is unmounted',async()=>{
  let resolve!: (value: SavedBattle)=>void; vi.mocked(publishSavedBattle).mockReturnValue(new Promise(done=>{resolve=done}));
  const onBattleChange=vi.fn();BattleResultShare({battle,onBattleChange}).props.children[0].props.onClick();
  states.cleanup?.();resolve({...battle,published:true});await settle();
  expect(onBattleChange).not.toHaveBeenCalled();expect(shareAuraChallenge).not.toHaveBeenCalled();
 });
 it('reuses a published page and does not claim a finale for a saved frame alone',async()=>{
  const tree=BattleResultShare({battle:{...battle,published:true,finisher:undefined}});
  expect(tree.props.children[0].props.children).toBe('Share battle');tree.props.children[0].props.onClick();await settle();
  expect(publishSavedBattle).not.toHaveBeenCalled();expect(shareAuraChallenge).toHaveBeenCalledTimes(1);
 });
 it('does not hand off a link if publication fails',async()=>{
  vi.mocked(publishSavedBattle).mockRejectedValue(new Error('Offline'));
  BattleResultShare({battle}).props.children[0].props.onClick();await settle();
  expect(shareAuraChallenge).not.toHaveBeenCalled();expect(states.values).toContain('Offline');
 });
});
