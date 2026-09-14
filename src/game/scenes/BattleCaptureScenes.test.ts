import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: { Scene: class {}, Input: { Keyboard: { KeyCodes: { ESC: 27, ENTER: 13, R: 82 } } } } }));
import { FightScene } from './FightScene.ts';
import { RushScene } from './RushScene.ts';
import { MATCH_COMPLETE_EVENT, RUSH_RUN_COMPLETE_EVENT } from '../match/MatchConfig.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('scene final-still association', () => {
  it.each([
    { winner: 'p1', p1X: 240, p2X: 760, side: 'left' },
    { winner: 'p2', p1X: 240, p2X: 760, side: 'right' },
    { winner: 'p1', p1X: 760, p2X: 240, side: 'right' },
    { winner: 'p2', p1X: 760, p2X: 240, side: 'left' },
  ] as const)('Fight captures the actual $winner on the $side after final positions settle', ({ winner, p1X, p2X, side }) => {
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    const capture = vi.fn();
    const positions = [240, 760];
    const scene = Object.assign(Object.create(FightScene.prototype), {
      battleCapture: { capture }, matchReported: false, matchStartedAt: Date.now() - 12_000,
      p1Name: 'Donald Trump', p2Name: 'Lamine Yamal', stageDisplayLabel: 'Aura Plaza', resolvedStageId: 'aura-plaza', matchSeed: 67,
      experience: 'trial', isVsAI: true, cpuVsCpu: false, online: null,
      p1CloudFighterId: null, p2CloudFighterId: null, sim: { p1Wins: winner === 'p1' ? 1 : 0, p2Wins: winner === 'p2' ? 1 : 0 },
      syncViews: vi.fn(), p1View: { getVisibleTopCenter: () => ({ x: positions[0] }) }, p2View: { getVisibleTopCenter: () => ({ x: positions[1] }) },
      sound_mgr: { stopBattleMusic: vi.fn() }, setMatchActionsVisible: vi.fn(),
      input: { keyboard: { addKey: () => ({ once: vi.fn() }) } },
    });
    scene.reportMatchComplete(winner);
    expect(dispatchEvent.mock.calls[0][0].type).toBe(MATCH_COMPLETE_EVENT);
    expect(capture).not.toHaveBeenCalled();
    scene.reportMatchComplete(winner === 'p1' ? 'p2' : 'p1');
    positions[0] = p1X; positions[1] = p2X;
    scene.showMatchOverUI();
    expect(capture).toHaveBeenCalledExactlyOnceWith(scene, {
      game: 'fight', winner, winnerSide: side, p1Name: 'Donald Trump', p2Name: 'Lamine Yamal', stageLabel: 'Aura Plaza', stageId: 'aura-plaza',
      durationSeconds: 12, p1Score: scene.sim.p1Wins, p2Score: scene.sim.p2Wins, seed: 67,
    });
  });

  function rushHarness() {
    const capture = vi.fn(), syncPresentations = vi.fn();
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    vi.useFakeTimers();
    const scene = Object.assign(Object.create(RushScene.prototype), {
      battleCapture: { capture }, runSummaryReported: false, waitingForRunAction: false,
      inputManager: { reset: vi.fn() }, stageId: 'side-street', rushDifficulty: 'arcade', lifecycle: 1,
      matchData: { p1Name: 'Trump', p2Name: 'Rosalía', seed: 42 },
      sim: { tick: 6000, players: [{ id: 'p1', health: 70, maxHealth: 100 }, { id: 'p2', health: 35, maxHealth: 100 }], enemies: [{ id: 'e1', health: 0 }] },
      cameras: { main: { worldView: { left: 0, right: 1024 } } },
      presentations: new Map([['p1', 700], ['p2', 800], ['e1', 400]].map(([id, x]) => [id, { view: { sprite: { visible: true, alpha: 1 }, getVisibleTopCenter: () => ({ x }) } }])),
      runStats: { enemiesDefeated: 8, obstaclesDestroyed: 2, checkpointsCleared: 1, revives: 1, damageTaken: 95 },
      scene: { isActive: () => true }, time: { delayedCall: (ms: number, callback: () => void) => setTimeout(callback, ms) },
      syncPresentations,
    });
    return { scene, capture, syncPresentations, dispatchEvent };
  }
  it.each(['won', 'lost'] as const)('Rush captures its frozen team/rivals %s outcome after clearing the last flash', outcome => {
    const { scene, capture, syncPresentations, dispatchEvent } = rushHarness();
    if (outcome === 'lost') { scene.sim.players.forEach((actor: any) => { actor.health = 0; }); scene.sim.enemies[0].health = 100; }
    scene.finishRun(outcome);
    expect(dispatchEvent.mock.calls[0][0].type).toBe(RUSH_RUN_COMPLETE_EVENT);
    expect(capture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(syncPresentations).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledExactlyOnceWith(scene, expect.objectContaining({
      game: 'rush', winner: outcome === 'won' ? 'team' : 'rivals', winnerSide: outcome === 'won' ? 'right' : 'left', p1Name: 'Trump + Rosalía', p2Name: 'Rivals', durationSeconds: 100, seed: 42,
    }));
    expect(syncPresentations.mock.invocationCallOrder[0]).toBeLessThan(capture.mock.invocationCallOrder[0]);
  });
  it('does not capture an old Rush result after a restart', () => {
    const { scene, capture, syncPresentations } = rushHarness();
    scene.finishRun('won'); scene.lifecycle = 2;
    vi.advanceTimersByTime(250);
    expect(capture).not.toHaveBeenCalled(); expect(syncPresentations).not.toHaveBeenCalled();
  });
});
