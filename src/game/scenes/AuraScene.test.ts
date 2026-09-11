import { afterEach, describe, expect, it, vi } from 'vitest';
import { FighterState } from '../constants.ts';
import { Fighter } from '../fighters/Fighter.ts';
import { EMPTY_INPUT } from '../sim/FighterInput.ts';
import { AuraMusicClock } from '../aura/AuraMusicClock.ts';
import { SoundManager } from '../systems/SoundManager.ts';
import { AuraStartup, AURA_STARTUP_EVENT } from '../aura/AuraStartup.ts';
import { AuraOnboarding, AURA_ONBOARDING_EVENT, AURA_PRACTICE_TRAVEL_MS } from '../aura/AuraOnboarding.ts';
import { AURA_CAMERA_FINALE_MS, AURA_CAMERA_HANDOFF_MS } from '../aura/AuraCamera.ts';
import { AuraBattle } from '../aura/AuraBattle.ts';
import { AuraRecorder } from '../aura/AuraRecording.ts';
import { AuraVideoRecorder, type AuraVideoRecording } from '../aura/AuraVideoRecorder.ts';
import { createAuraChart } from '../aura/AuraChart.ts';
import { DEFAULT_AURA_TRACK } from '../aura/AuraTracks.ts';
import { AURA_DEFAULT_LANE_KEYS, AURA_LOCAL_P1_LANE_KEYS, AURA_LOCAL_P2_LANE_KEYS } from '../aura/AuraConfig.ts';
import { auraComicAnchor, auraPerformerPlacement, auraPerformerTransform, createAuraLayout } from '../aura/AuraLayout.ts';
import { AURA_PRESENTATION_EVENT, AURA_PRESENTATION_TURN_EVENT } from '../aura/AuraPresentationEvents.ts';
import { buildAuraChallengeMatch, createAuraChallenge, createAuraChallengeRoutine } from '../aura/AuraChallenge.ts';
import { AURA_PLAZA_ASSET_PATH, DEFAULT_AURA_STAGE_ID, getStageTheme } from '../match/StageConfig.ts';
import type { MatchSceneData } from '../match/MatchConfig.ts';
import { AURA_ANIMATION_NAMES } from '../../services/FighterAssetPacks.ts';
import type { LoadedAuraAnimationPack } from '../aura/AuraSpriteLoader.ts';

const assetLoaders = vi.hoisted(() => ({ aura: vi.fn(), combat: vi.fn() }));
vi.mock('../sprites/AiSpriteLoader.ts', () => ({ loadAiSprites: assetLoaders.combat }));
vi.mock('../aura/AuraSpriteLoader.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../aura/AuraSpriteLoader.ts')>(),
  loadAuraAnimationPack: assetLoaders.aura,
}));

vi.mock('phaser', () => ({ default: {
  Scene: class {},
  Geom: { Point: class { constructor(public x: number, public y: number) {} } },
  Math: {
    Clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
    Linear: (start: number, end: number, progress: number) => start + (end - start) * progress,
  },
  Scale: { Events: { RESIZE: 'resize' } },
  BlendModes: { ADD: 1 },
} }));

import { AuraScene } from './AuraScene.ts';

describe('AuraScene stage defaults and authored floor', () => {
  it.each([1, 3, 67, 902])('preloads the Aura plaza independently of random match seed %i', matchSeed => {
    const image = vi.fn();
    const scene = Object.assign(new AuraScene() as unknown as Record<string, any>, {
      stageId: null, matchSeed, textures: { exists: () => false }, load: { image },
    });
    scene.preload();
    expect(image).toHaveBeenCalledExactlyOnceWith(`aura_stage_${DEFAULT_AURA_STAGE_ID}`, AURA_PLAZA_ASSET_PATH);
  });

  it('preloads an explicitly chosen legacy stage unchanged', () => {
    const image = vi.fn();
    const scene = Object.assign(new AuraScene() as unknown as Record<string, any>, {
      stageId: 'executive-rumble', matchSeed: 67, textures: { exists: () => false }, load: { image },
    });
    scene.preload();
    expect(image).toHaveBeenCalledExactlyOnceWith('aura_stage_executive-rumble', getStageTheme('executive-rumble').assetPath);
  });

  it('loads the original Aura Plaza under its own texture key for saved challenges', () => {
    const image = vi.fn();
    const scene = Object.assign(new AuraScene() as unknown as Record<string, any>, {
      stageId: 'aura-plaza', textures: { exists: (key: string) => key === `aura_stage_${DEFAULT_AURA_STAGE_ID}` }, load: { image },
    });
    scene.preload();
    expect(image).toHaveBeenCalledExactlyOnceWith('aura_stage_aura-plaza', '/assets/stages/aura/aura-plaza-v1.webp');
  });

  it.each([[1024, 576], [576, 1024]])('pins the authored floor to performer feet and covers the visible stage at %ix%i', (width, height) => {
    const layout = createAuraLayout(width, height);
    const backdrop = {
      frame: { realWidth: 2048, realHeight: 1152 },
      displayWidth: 0, displayHeight: 0, x: 0, y: 0,
      setDisplaySize(displayWidth: number, displayHeight: number) { Object.assign(this, { displayWidth, displayHeight }); return this; },
      setPosition(x: number, y: number) { Object.assign(this, { x, y }); return this; },
    };
    const grade = { clear: vi.fn().mockReturnThis(), fillStyle: vi.fn().mockReturnThis(), fillRect: vi.fn().mockReturnThis() };
    const scene = Object.assign(new AuraScene() as unknown as Record<string, any>, {
      layout, resolvedStageId: DEFAULT_AURA_STAGE_ID, stageBackdrop: backdrop, stageGrade: grade, customStageTextureKey: null as string | null,
    });
    scene.layoutStage();
    const top = backdrop.y - backdrop.displayHeight / 2;
    expect(top + 0.82 * backdrop.displayHeight).toBeCloseTo(layout.active.footY, 10);
    expect(top).toBeLessThanOrEqual(layout.stage.y + 1e-8);
    expect(top + backdrop.displayHeight).toBeGreaterThanOrEqual(layout.stage.y + layout.stage.height - 1e-8);
    expect(backdrop.displayWidth).toBeGreaterThanOrEqual(layout.stage.width);
    expect(backdrop.x).toBe(layout.stage.width / 2);

    scene.customStageTextureKey = 'photo-stage';
    scene.layoutStage();
    expect(backdrop.y + backdrop.displayHeight / 2).toBeCloseTo(layout.active.footY + 60, 10);
  });
});

function harness(withPack = true) {
  const makePerformance = () => ({
    play: vi.fn(() => true), firstRoutineAnimation: vi.fn(() => 'aura_glide'),
    playResting: vi.fn(() => true), playFinale: vi.fn(() => true), flash: vi.fn(() => true), interrupt: vi.fn(), update: vi.fn(),
    getVisibleTopCenter: vi.fn(() => ({ x: 250, y: 220 })),
  });
  const performance = makePerformance();
  const waiting = makePerformance();
  const fighters = [new Fighter(0, 'P1', 250, true), new Fighter(1, 'P2', 774, false)];
  fighters.forEach(fighter => { vi.spyOn(fighter, 'forceState'); vi.spyOn(fighter, 'update'); });
  const views = fighters.map(() => ({
    sprite: { setTintFill: vi.fn(), setTint: vi.fn(), clearTint: vi.fn(), setAlpha: vi.fn() },
    shadowSprite: { setAlpha: vi.fn() }, syncSprite: vi.fn(), setRenderPresentation: vi.fn(),
    getVisibleTopCenter: vi.fn(() => ({ x: 250, y: 220 })),
  }));
  const scene = Object.assign(Object.create(AuraScene.prototype), {
    layout: createAuraLayout(), applyPerformerLayout: vi.fn(), fitHudText: vi.fn(), emitPresentationTurn: vi.fn(),
    matchData: {}, p1Name: 'P1', p2Name: 'P2', performerNameText: controlText(),
    fighters, views, auraPerformanceViews: withPack ? [performance, waiting] : [null, null],
    activePerformerSlot: 0, matchFinished: false,
    cameraFocusSlot: 0, cameraFromSlot: 0, cameraTransitionMs: AURA_CAMERA_HANDOFF_MS, finaleElapsedMs: null, stageFrame: null,
    canaryPerformanceOverride: 'aura_six_seven',
    noteById: new Map([['n1', { id: 'n1', beat: 0.5, turnIndex: 0 }]]),
    chart: { turns: [{ round: 0, slot: 0, startMs: 0, endMs: 10_000 }], beatMs: 500, beatOffsetMs: 0 },
    matchSeed: 67, currentTurnIndex: 0, noteObjects: new Map(), lastMilestone: [0, 0],
    comicFeedback: { move: vi.fn(), judgement: vi.fn(), milestone: vi.fn(), beginTurn: vi.fn() },
    // Regression sentinels: none of the removed world/sprite feedback paths may run.
    spawnPerformanceSparks: vi.fn(), playAuraBurst: vi.fn(), dipSpotlight: vi.fn(),
    flashPerformer: vi.fn(), updateOpponentReaction: vi.fn(),
    reduceMotion: false, time: { delayedCall: vi.fn() },
    tweens: { killTweensOf: vi.fn(), add: vi.fn() },
    cameras: { main: { shake: vi.fn(), flash: vi.fn() } },
    playerTags: [{ setPosition: vi.fn() }, { setPosition: vi.fn() }],
    fighterRenderScale: 1.2, fighterRenderYOffset: 20, camRig: { zoom: 1, scrollX: 0, scrollY: 0 },
    activeGlow: { setPosition: vi.fn().mockReturnThis(), setAlpha: vi.fn().mockReturnThis() },
    crowdHeat: [0.5, 0.5], stageEnergyForSlot: vi.fn(() => 0.5),
    drawStageLighting: vi.fn(), updateCrowdUi: vi.fn(), syncCrowdMix: vi.fn(),
    clockStartedAt: 0, pausedDuration: 0, paused: false, musicClock: new AuraMusicClock(), actionRecorder: null,
    soundManager: { setAuraCrowdMix: vi.fn(), getBattleMusicClockSample: vi.fn(() => (
      { status: 'playing', positionMs: 50, durationMs: null, loop: false }
    )) },
    showFeedback: vi.fn(), updateScoreUi: vi.fn(), renderDuelScoreUi: vi.fn(), battle: { scoreFor: vi.fn(() => ({ combo: 10 })) },
  });
  return { scene, performance, waiting };
}

function expectUntouchedWorld(scene: ReturnType<typeof harness>['scene']) {
  for (const effect of ['flashPerformer', 'spawnPerformanceSparks', 'playAuraBurst', 'dipSpotlight', 'updateOpponentReaction']) {
    expect(scene[effect]).not.toHaveBeenCalled();
  }
  expect(scene.cameras.main.shake).not.toHaveBeenCalled();
  expect(scene.cameras.main.flash).not.toHaveBeenCalled();
  for (const view of scene.views) {
    expect(view.sprite.setTintFill).not.toHaveBeenCalled();
    expect(view.sprite.setTint).not.toHaveBeenCalled();
    expect(view.sprite.setAlpha).not.toHaveBeenCalled();
  }
  for (const performance of scene.auraPerformanceViews) {
    if (performance) expect(performance.flash).not.toHaveBeenCalled();
  }
}

function loadedAuraPack(): LoadedAuraAnimationPack {
  return {
    complete: true,
    animations: new Map(AURA_ANIMATION_NAMES.map((name) => [name, {
      name, textureKey: name, frameWidth: 192, frameHeight: 256, frameCount: 8,
    }])),
    textureKeys: [...AURA_ANIMATION_NAMES],
  };
}

describe('AuraScene loaded performer eligibility', () => {
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

  function loadingScene(data: Partial<MatchSceneData> = {}) {
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), location: { search: '' },
      matchMedia: () => ({ matches: false }) });
    const scene = new AuraScene() as unknown as Record<string, any>;
    scene.init({ gameMode: 'aura', p1Name: 'P1', p2Name: 'P2',
      p1PhotoHash: 'player-photo', p2PhotoHash: 'rival-photo', ...data });
    Object.assign(scene, { lifecycleActive: true, lifecycleEpoch: 1 });
    assetLoaders.combat.mockResolvedValue(true);
    return scene;
  }

  it.each([0, 1])('rejects seat %i without a loaded Aura pack even when its combat sprites loaded', async slot => {
    const scene = loadingScene();
    const packs = [loadedAuraPack(), loadedAuraPack()] as Array<LoadedAuraAnimationPack | null>;
    packs[slot] = null;
    assetLoaders.aura.mockImplementation((_scene, spriteKey) => Promise.resolve(packs[spriteKey === 'fighter_p1' ? 0 : 1]));
    await expect(scene.loadFighters(1)).rejects.toThrow(`P${slot + 1} needs all six Aura performances`);
    expect(assetLoaders.combat).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { online: { localSlot: 0, matchSerial: 1 } }])('rejects a pack that lost a required move during decoding for match %o', data => {
    const scene = loadingScene(data as Partial<MatchSceneData>);
    const partial = loadedAuraPack();
    partial.complete = false;
    (partial.animations as Map<string, unknown>).delete('aura_glide');
    assetLoaders.aura.mockResolvedValueOnce(loadedAuraPack()).mockResolvedValueOnce(partial);
    return expect(scene.loadFighters(1)).rejects.toThrow('P2 needs all six Aura performances');
  });

  it('accepts complete performance packs in both seats without optional shrug or combat sprites', async () => {
    const scene = loadingScene();
    const packs = [loadedAuraPack(), loadedAuraPack()];
    assetLoaders.aura.mockResolvedValueOnce(packs[0]).mockResolvedValueOnce(packs[1]);
    assetLoaders.combat.mockResolvedValue(false);
    await expect(scene.loadFighters(1)).resolves.toBeUndefined();
    expect(scene.auraAnimationPacks).toEqual(packs);
    expect(packs.every(pack => !pack.animations.has('aura_shrug'))).toBe(true);
  });

  it('passes Nova and Byte to the real loader as explicit built-in performers', async () => {
    const scene = loadingScene({ p1Name: 'NOVA', p2Name: 'BYTE', p1PhotoHash: undefined, p2PhotoHash: undefined });
    assetLoaders.aura.mockResolvedValue(loadedAuraPack());
    await scene.loadFighters(1);
    expect(assetLoaders.aura).toHaveBeenNthCalledWith(1, scene, 'fighter_p1', null, expect.any(Function),
      { id: 'template-zero', tint: 0xffffff });
    expect(assetLoaders.aura).toHaveBeenNthCalledWith(2, scene, 'fighter_p2', null, expect.any(Function),
      { id: 'template-zero', tint: 0x8cdeff });
    expect(assetLoaders.combat).not.toHaveBeenCalled();
  });

  it('does not report missing performers or store late packs after a scene has ended', async () => {
    const scene = loadingScene();
    let resolveLoad!: (pack: null) => void;
    const pending = new Promise<null>(resolve => { resolveLoad = resolve; });
    assetLoaders.aura.mockReturnValue(pending);
    const loading = scene.loadFighters(1);
    scene.lifecycleActive = false;
    resolveLoad(null);
    await expect(loading).resolves.toBeUndefined();
    expect(scene.auraAnimationPacks).toEqual([null, null]);
  });
});

describe('AuraScene integrated presentation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['perfect', 'great', 'good', 'miss', 'mash'])('keeps the selected Aura pack on %s and sends only UI feedback', grade => {
    const { scene, performance, waiting } = harness();
    scene.animateFighterForJudgement({ grade, slot: 0, lane: 2, noteId: 'n1' });
    expect(performance.play).toHaveBeenCalledWith('aura_six_seven');
    expect(scene.fighters[0].forceState).toHaveBeenCalledExactlyOnceWith(FighterState.IDLE);
    expect(performance.update).toHaveBeenCalledWith(0, scene.views[0]);
    expect(performance.interrupt).not.toHaveBeenCalled();
    if (grade === 'miss' || grade === 'mash') expect(scene.comicFeedback.move).not.toHaveBeenCalled();
    else expect(scene.comicFeedback.move).toHaveBeenCalledExactlyOnceWith(0, 'aura_six_seven', {
      key: 'D', tone: expect.any(Number), phrase: '0:aura_six_seven',
    });
    expect(scene.comicFeedback.judgement).toHaveBeenCalledExactlyOnceWith(0, grade === 'miss' || grade === 'mash');
    expect(waiting.play).not.toHaveBeenCalled();
    expectUntouchedWorld(scene);
  });

  it('keeps a partial pack as the identity source when the requested move is absent', () => {
    const { scene, performance } = harness();
    performance.play.mockReturnValueOnce(false);
    scene.animateFighterForJudgement({ grade: 'good', slot: 0, lane: 1, noteId: 'n1' });
    expect(performance.play.mock.calls).toEqual([['aura_six_seven'], ['aura_glide']]);
    expect(scene.fighters[0].forceState).toHaveBeenCalledExactlyOnceWith(FighterState.IDLE);
    expect(scene.comicFeedback.move).toHaveBeenCalledExactlyOnceWith(0, 'aura_glide', {
      key: 'S', tone: expect.any(Number), phrase: '0:aura_six_seven',
    });
  });

  it.each([
    { isVsAI: true, slot: 0, key: 'J' },
    { isVsAI: false, slot: 1, key: 'L' },
    { online: { localSlot: 1 }, slot: 1, key: 'J' },
    { cpuVsCpu: true, slot: 1, key: '3' },
  ])('labels successful history with the active input mapping: %j', ({ slot, key, ...mode }) => {
    const { scene } = harness();
    Object.assign(scene, mode, { activePerformerSlot: slot });
    scene.animateFighterForJudgement({ grade: 'perfect', slot, lane: 2, noteId: 'n1' });
    expect(scene.comicFeedback.move).toHaveBeenCalledWith(slot, 'aura_six_seven', expect.objectContaining({ key }));
  });

  it('keeps fallback choreography without inventing a dance label or changing source pixels', () => {
    const { scene } = harness(false);
    scene.animateFighterForJudgement({ grade: 'miss', slot: 0, lane: 0, noteId: 'n1' });
    expect(scene.fighters[0].forceState).toHaveBeenCalledExactlyOnceWith(FighterState.LOW_PUNCH);
    scene.animateFighterForJudgement({ grade: 'great', slot: 0, lane: 0, noteId: 'n1' });
    expect(scene.comicFeedback.move).not.toHaveBeenCalled();
    expect(scene.comicFeedback.judgement.mock.calls).toEqual([[0, true], [0, false]]);
    expectUntouchedWorld(scene);
  });

  it.each([true, false])('celebrates a milestone only in UI, with Aura pack=%s', withPack => {
    const { scene } = harness(withPack);
    scene.playMilestone(0, 10);
    expect(scene.comicFeedback.milestone).toHaveBeenCalledExactlyOnceWith(0, 10);
    expect(scene.fighters[0].forceState).not.toHaveBeenCalled();
    expect(scene.tweens.add).not.toHaveBeenCalled();
    expectUntouchedWorld(scene);
  });

  it.each([false, true])('ignores wrong-turn and stale actor feedback with reduced motion=%s', reduceMotion => {
    const { scene, performance, waiting } = harness();
    Object.assign(scene, { reduceMotion, activePerformerSlot: 1 });
    scene.animateFighterForJudgement({ grade: 'wrong_turn', slot: 1 });
    scene.animateFighterForJudgement({ grade: 'perfect', slot: 0, lane: 0, noteId: 'n1' });
    scene.playMilestone(0, 20);
    for (const actor of [performance, waiting]) {
      expect(actor.play).not.toHaveBeenCalled();
      expect(actor.update).not.toHaveBeenCalled();
    }
    expect(scene.fighters.every((fighter: Fighter) => fighter.stateFrame === 0)).toBe(true);
    expect(scene.comicFeedback.move).not.toHaveBeenCalled();
    expect(scene.comicFeedback.judgement).not.toHaveBeenCalled();
    expect(scene.comicFeedback.milestone).not.toHaveBeenCalled();
    expectUntouchedWorld(scene);
  });

  it('still scores and broadcasts late results without restarting the waiting performer', () => {
    const { scene, performance, waiting } = harness();
    delete scene.syncCrowdMix;
    const chart = createAuraChart(67);
    const battle = new AuraBattle(chart);
    const note = chart.turns[0].notes[0];
    Object.assign(scene, { chart, battle, activePerformerSlot: 1,
      noteById: new Map(chart.notes.map(note => [note.id, note])),
      online: { matchSerial: 7 }, onlineSession: { transport: { sendControl: vi.fn() } },
    });
    const judgement = battle.judgeNote(note.id, 'perfect', 12)!;
    scene.applyJudgement(judgement, true);
    expect(battle.scoreFor(0).perfect).toBe(1);
    expect(battle.scoreFor(0).score).toBeGreaterThan(0);
    expect(scene.updateScoreUi).toHaveBeenCalledOnce();
    expect(scene.showFeedback).toHaveBeenCalledWith(judgement);
    expect(scene.onlineSession.transport.sendControl).toHaveBeenCalledExactlyOnceWith({
      t: 'aura_judgement', matchSerial: 7, noteId: note.id, grade: 'perfect', offsetMs: 12,
    });
    expect(scene.crowdHeat[0]).toBeCloseTo(0.525);
    expect(scene.crowdHeat[1]).toBe(0.5);
    expect(scene.soundManager.setAuraCrowdMix).not.toHaveBeenCalled();
    expect(performance.play).not.toHaveBeenCalled();
    expect(waiting.play).not.toHaveBeenCalled();
    expect(scene.comicFeedback.move).not.toHaveBeenCalled();
    expectUntouchedWorld(scene);
  });

  it('keeps miss streak feedback in UI and crowd audio, never waking the opponent or changing stage lights', () => {
    const { scene, waiting } = harness();
    for (const grade of ['miss', 'mash', 'miss', 'miss']) {
      scene.applyJudgement({ grade, slot: 0, lane: 0, noteId: null, combo: 0 }, false);
    }
    expect(scene.comicFeedback.judgement.mock.calls).toEqual(Array(4).fill([0, true]));
    expect(scene.updateScoreUi).toHaveBeenCalledTimes(4);
    expect(scene.showFeedback).toHaveBeenCalledTimes(4);
    expect(scene.syncCrowdMix).toHaveBeenCalledTimes(4);
    expect(scene.updateCrowdUi).toHaveBeenCalledTimes(4);
    expect(scene.drawStageLighting).not.toHaveBeenCalled();
    expect(scene.crowdHeat[0]).toBe(0);
    expect(waiting.play).not.toHaveBeenCalled();
    expect(waiting.playResting).not.toHaveBeenCalled();
    expect(waiting.interrupt).not.toHaveBeenCalled();
    expect(scene.fighters[1].forceState).not.toHaveBeenCalled();
    expect(scene.time.delayedCall).not.toHaveBeenCalled();
    expectUntouchedWorld(scene);
  });

  it('builds crowd heat over forty clean notes instead of saturating in the first phrase', () => {
    const { scene } = harness();
    delete scene.syncCrowdMix;
    scene.crowdHeat = [0, 0];
    for (let combo = 1; combo <= 40; combo++) {
      scene.reactCrowd({ grade: 'perfect', slot: 0, combo });
      expect(scene.crowdHeat[0]).toBeCloseTo(combo / 40, 10);
      if (combo === 10) expect(scene.crowdHeat[0]).toBeCloseTo(0.25, 10);
    }
    scene.reactCrowd({ grade: 'perfect', slot: 0, combo: 41 });
    expect(scene.crowdHeat).toEqual([1, 0]);
    expect(scene.soundManager.setAuraCrowdMix).toHaveBeenCalledTimes(41);
    expect(scene.soundManager.setAuraCrowdMix).toHaveBeenNthCalledWith(10, expect.closeTo(0.25, 10), 0, 0);
    expect(scene.soundManager.setAuraCrowdMix).toHaveBeenLastCalledWith(1, 0, 0);
    expect(scene.time.delayedCall).not.toHaveBeenCalled();
  });

  it.each([
    { grade: 'perfect', gain: 0.025 },
    { grade: 'great', gain: 0.018 },
    { grade: 'good', gain: 0.012 },
  ])('keeps the $grade heat gain small when combo does not impose a higher floor', ({ grade, gain }) => {
    const { scene } = harness();
    delete scene.syncCrowdMix;
    scene.crowdHeat = [0.2, 0.7];
    scene.reactCrowd({ grade, slot: 0, combo: 1 });
    expect(scene.crowdHeat[0]).toBeCloseTo(0.2 + gain, 10);
    expect(scene.crowdHeat[1]).toBe(0.7);
    expect(scene.soundManager.setAuraCrowdMix).toHaveBeenCalledExactlyOnceWith(expect.closeTo(0.2 + gain, 10), 0, 0);
  });

  it.each([
    { grade: 'miss', remaining: 0.36, punch: 0.64 },
    { grade: 'mash', remaining: 0.56, punch: 0.32 },
  ])('drops existing heat on $grade and scales the reaction only from heat before failure', ({ grade, remaining, punch }) => {
    const { scene } = harness();
    delete scene.syncCrowdMix;
    scene.crowdHeat = [0.8, 0.7];
    scene.reactCrowd({ grade, slot: 0, combo: 0 });
    expect(scene.crowdHeat[0]).toBeCloseTo(remaining, 10);
    expect(scene.crowdHeat[1]).toBe(0.7);
    expect(scene.soundManager.setAuraCrowdMix).toHaveBeenCalledExactlyOnceWith(expect.closeTo(remaining, 10), 0, expect.closeTo(punch, 10));
    for (let failure = 0; failure < 20; failure++) scene.reactCrowd({ grade, slot: 0, combo: 0 });
    expect(scene.crowdHeat[0]).toBe(0);
    expect(scene.soundManager.setAuraCrowdMix).toHaveBeenLastCalledWith(0, 0, 0);
    expect(scene.time.delayedCall).not.toHaveBeenCalled();
  });

  it.each(['miss', 'mash'])('does not invent a crowd outburst for a $grade from a cold room', grade => {
    const { scene } = harness();
    delete scene.syncCrowdMix;
    scene.crowdHeat = [0, 0.7];
    scene.reactCrowd({ grade, slot: 0, combo: 0 });
    expect(scene.crowdHeat).toEqual([0, 0.7]);
    expect(scene.soundManager.setAuraCrowdMix).toHaveBeenCalledExactlyOnceWith(0, 0, 0);
  });

  it.each([1, null])('updates late heat without disturbing the crowd while active seat is %s', activePerformerSlot => {
    const { scene } = harness();
    delete scene.syncCrowdMix;
    Object.assign(scene, { activePerformerSlot, crowdHeat: [0.8, 0.7] });
    scene.reactCrowd({ grade: 'miss', slot: 0, combo: 0 });
    scene.reactCrowd({ grade: 'perfect', slot: 0, combo: 1 });
    expect(scene.crowdHeat[0]).toBeCloseTo(0.385, 10);
    expect(scene.crowdHeat[1]).toBe(0.7);
    expect(scene.soundManager.setAuraCrowdMix).not.toHaveBeenCalled();
    expect(scene.updateCrowdUi).not.toHaveBeenCalled();
    scene.activePerformerSlot = 0;
    scene.syncCrowdMix(0);
    expect(scene.soundManager.setAuraCrowdMix).toHaveBeenCalledExactlyOnceWith(expect.closeTo(0.385, 10), 0, 0);
  });

  it('ignores wrong-turn judgements for both crowd heat and audio', () => {
    const { scene } = harness();
    delete scene.syncCrowdMix;
    scene.applyJudgement({ grade: 'wrong_turn', slot: 0, lane: 0, noteId: null, combo: 40 }, false);
    scene.reactCrowd({ grade: 'wrong_turn', slot: 0, combo: 40 });
    expect(scene.crowdHeat).toEqual([0.5, 0.5]);
    expect(scene.soundManager.setAuraCrowdMix).not.toHaveBeenCalled();
    expect(scene.updateCrowdUi).not.toHaveBeenCalled();
  });

  it('does not require the optional comic overlay to preserve animation or milestones', () => {
    const { scene, performance } = harness();
    scene.comicFeedback = null;
    expect(() => {
      scene.animateFighterForJudgement({ grade: 'good', slot: 0, lane: 0, noteId: 'n1' });
      scene.playMilestone(0, 10);
    }).not.toThrow();
    expect(performance.play).toHaveBeenCalledWith('aura_six_seven');
    expectUntouchedWorld(scene);
  });

  it.each([true, false])('holds the inactive actor at a neutral frame across handoffs, with Aura pack=%s', withPack => {
    const { scene, performance, waiting } = harness(withPack);
    scene.reduceMotion = true;
    scene.fighters[0].forceState(FighterState.HIGH_KICK);
    scene.fighters[1].forceState(FighterState.UPPERCUT);
    scene.fighters[0].stateFrame = 7;
    scene.fighters[1].stateFrame = 8;
    scene.focusPerformer(0);
    expect(scene.fighters.map((fighter: Fighter) => [fighter.state, fighter.stateFrame]))
      .toEqual([[FighterState.IDLE, 0], [FighterState.IDLE, 0]]);
    for (const view of scene.views) {
      expect(view.sprite.setAlpha).toHaveBeenLastCalledWith(1);
      expect(view.setRenderPresentation).toHaveBeenCalledWith(1.2, 20);
    }
    scene.fighters.forEach((fighter: Fighter) => vi.mocked(fighter.update).mockClear());
    performance.update.mockClear(); waiting.update.mockClear();
    const restingBefore = scene.fighters[1].snapshot();
    for (const dt of [1 / 60, 0, 1]) scene.advanceFighterPresentation(dt);
    expect(scene.fighters[0].stateFrame).toBe(2);
    expect(scene.fighters[1].snapshot()).toEqual(restingBefore);
    expect(scene.fighters[0].update).toHaveBeenCalledTimes(2);
    expect(scene.fighters[1].update).not.toHaveBeenCalled(); // update(0) would still tick Fighter.
    if (withPack) {
      expect(performance.update.mock.calls.map(call => call[0])).toEqual([1_000 / 60, 0, 1_000]);
      expect(waiting.update.mock.calls.map(call => call[0])).toEqual([0, 0, 0]);
      expect(performance.playResting).toHaveBeenCalledOnce();
      expect(waiting.playResting).toHaveBeenCalledOnce();
    }

    scene.focusPerformer(1);
    scene.fighters.forEach((fighter: Fighter) => vi.mocked(fighter.update).mockClear());
    scene.advanceFighterPresentation(1 / 60);
    expect(scene.fighters[0].stateFrame).toBe(0);
    expect(scene.fighters[0].update).not.toHaveBeenCalled();
    expect(scene.fighters[1].stateFrame).toBe(1);
    expect(scene.fighters[1].update).toHaveBeenCalledOnce();
    expect(scene.views[0].syncSprite).toHaveBeenLastCalledWith(774);
    expect(scene.views[1].syncSprite).toHaveBeenLastCalledWith(250);
  });

  it('rests on the base idle when a partial Aura pack has no neutral pose', () => {
    const { scene, waiting } = harness();
    waiting.playResting.mockReturnValue(false);
    scene.fighters[1].forceState(FighterState.HIGH_KICK);
    scene.restPerformer(1);
    expect(scene.fighters[1].state).toBe(FighterState.IDLE);
    expect(scene.fighters[1].stateFrame).toBe(0);
    expect(waiting.interrupt).toHaveBeenCalledExactlyOnceWith(scene.views[1]);
    expect(waiting.play).not.toHaveBeenCalled();
    expect(waiting.update).toHaveBeenCalledExactlyOnceWith(0, scene.views[1]);
  });

  it('freezes both actors during count-in, then still advances the real end-of-match states', () => {
    const { scene, performance, waiting } = harness();
    scene.focusBoth();
    expect(scene.activePerformerSlot).toBeNull();
    scene.advanceFighterPresentation(10);
    expect(scene.fighters.map((fighter: Fighter) => fighter.stateFrame)).toEqual([0, 0]);
    expect(scene.fighters[0].update).not.toHaveBeenCalled();
    expect(scene.fighters[1].update).not.toHaveBeenCalled();
    expect(performance.playResting).toHaveBeenCalledOnce();
    expect(waiting.playResting).toHaveBeenCalledOnce();

    scene.matchFinished = true;
    scene.fighters[0].forceState(FighterState.VICTORY);
    scene.fighters[1].forceState(FighterState.DEFEAT);
    scene.advanceFighterPresentation(1 / 60);
    expect(scene.fighters.map((fighter: Fighter) => [fighter.state, fighter.stateFrame]))
      .toEqual([[FighterState.VICTORY, 1], [FighterState.DEFEAT, 1]]);
    expect(performance.update).toHaveBeenLastCalledWith(1_000 / 60, scene.views[0]);
    expect(waiting.update).toHaveBeenLastCalledWith(1_000 / 60, scene.views[1]);
  });

  it('keeps cameras fixed across turns and beats while receptor feedback remains', () => {
    const { scene } = harness();
    Object.assign(scene, {
      beatGraphics: controlGraphics(), comboText: controlText(),
      stageLights: { setAlpha: vi.fn() },
      updateCountIn: vi.fn(),
    });
    Object.assign(scene.cameras.main, { setZoom: vi.fn(), setScroll: vi.fn() });
    scene.focusPerformer(0);
    scene.focusPerformer(1);
    scene.focusBoth();
    scene.activeGlow.setAlpha.mockClear();
    for (const nowMs of [0, 250, 500, 2_000]) {
      scene.updateBeatPresentation(nowMs);
    }
    expect(scene.cameras.main.setZoom).not.toHaveBeenCalled();
    expect(scene.cameras.main.setScroll).not.toHaveBeenCalled();
    expect(scene.stageLights.setAlpha).not.toHaveBeenCalled();
    expect(scene.activeGlow.setAlpha).not.toHaveBeenCalled();
    expect(scene.tweens.add).not.toHaveBeenCalled();
    expect(scene.beatGraphics.strokePoints).toHaveBeenCalledTimes(16);
    expect(scene.updateCountIn).toHaveBeenCalledTimes(4);
    expect(scene.applyPerformerLayout).toHaveBeenCalledTimes(3);
  });

  it('samples the audio clock on input and freezes it while the scene is paused', () => {
    vi.spyOn(globalThis.performance, 'now').mockReturnValue(10_000);
    const { scene } = harness();
    Object.assign(scene, { clockStartedAt: 0, pausedDuration: 0, paused: false,
      musicClock: new AuraMusicClock(), soundManager: { getBattleMusicClockSample: vi.fn(() => ({ status: 'playing', positionMs: 50, durationMs: null, loop: false })) } });
    expect(scene.clockMs()).toBe(50); // wall/audio difference greater than five seconds
    scene.paused = true;
    expect(scene.clockMs()).toBe(50);
    expect(scene.soundManager.getBattleMusicClockSample).toHaveBeenCalledOnce();
  });

  it('ignores paused keyboard/touch inputs without judging, flashing or advancing the media clock', () => {
    const { scene } = harness();
    Object.assign(scene, { paused: true, clockStartedAt: 0, musicClock: new AuraMusicClock(),
      soundManager: { getBattleMusicClockSample: vi.fn() },
      battle: { judgeInput: vi.fn() }, flashLaneInput: vi.fn(), applyJudgement: vi.fn() });
    scene.handleInput(0, 1);
    scene.handleInput(0, 1, 999);
    expect(scene.battle.judgeInput).not.toHaveBeenCalled();
    expect(scene.flashLaneInput).not.toHaveBeenCalled();
    expect(scene.applyJudgement).not.toHaveBeenCalled();
    expect(scene.soundManager.getBattleMusicClockSample).not.toHaveBeenCalled();
    expect(scene.musicClock.timeMs).toBe(0);
  });
});

function recordingHarness() {
  const { scene } = harness();
  const chart = createAuraChart(67, 'viral');
  const recorder = new AuraRecorder({ engineVersion: 'aura-presentation-v1', matchSeed: chart.seed,
    trackId: chart.trackId, difficulty: chart.difficulty, stageId: 'mars-incorporated',
    p1Name: 'P1', p2Name: 'P2', chart });
  Object.assign(scene, { chart, actionRecorder: recorder, battle: new AuraBattle(chart),
    isVsAI: false, cpuVsCpu: false, online: null, finalizing: false,
    noteById: new Map(chart.notes.map(note => [note.id, note])),
    lastWrongTurnFeedbackAt: -Infinity, flashLaneInput: vi.fn(),
  });
  return { scene, recorder, chart };
}

describe('AuraScene actual action recording integration', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('records every wrong-turn attempt, including same-time repeats, independently of the visual throttle', () => {
    const { scene, recorder, chart } = recordingHarness();
    const atMs = chart.turns[0].startMs + 0.125;
    const clock = vi.spyOn(scene, 'clockMs');
    const times = [atMs, atMs, atMs + 25, atMs + 651];
    for (const time of times) scene.handleInput(1, 2, time);
    expect(recorder.toRecording().events.map(event => ({ atMs: event.atMs, sequence: event.sequence,
      grade: event.judgement.grade, slot: event.judgement.slot })))
      .toEqual(times.map((atMs, sequence) => ({ atMs, sequence, grade: 'wrong_turn', slot: 1 })));
    expect(scene.showFeedback).toHaveBeenCalledTimes(2);
    expect(scene.updateScoreUi).not.toHaveBeenCalled();
    expect(scene.flashLaneInput).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(recorder.toRecording().status).toBe('recording');
  });

  it('uses the exact human judgement clock sample once, not a later media resample', () => {
    const { scene, recorder, chart } = recordingHarness();
    const note = chart.notes[0];
    const atMs = note.atMs + 12.125;
    scene.soundManager.getBattleMusicClockSample.mockReturnValue({
      status: 'playing', positionMs: atMs, durationMs: null, loop: false,
    });
    scene.handleInput(note.slot, note.lane);
    const events = recorder.toRecording().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ atMs, sequence: 0,
      judgement: { grade: 'perfect', noteId: note.id, offsetMs: 12.125 } });
    expect(scene.soundManager.getBattleMusicClockSample).toHaveBeenCalledOnce();
    expect(scene.flashLaneInput).toHaveBeenCalledExactlyOnceWith(note.slot, note.lane);
  });

  it('records CPU catch-up judgements at their actual shared presentation time, in application order', () => {
    const { scene, recorder, chart } = recordingHarness();
    const notes = chart.turns[0].notes.slice(0, 2);
    const nowMs = notes[1].atMs + 0.625;
    Object.assign(scene, { cpuVsCpu: true, cpuPlanIndices: [0, 0],
      cpuPlans: [notes.map(note => ({ noteId: note.id, grade: 'great', offsetMs: 80, atMs: note.atMs })), []],
    });
    const clock = vi.spyOn(scene, 'clockMs');
    scene.playCpuPlans(nowMs);
    expect(recorder.toRecording().events.map(event => [event.atMs, event.sequence, event.judgement.noteId]))
      .toEqual(notes.map((note, sequence) => [nowMs, sequence, note.id]));
    expect(clock).not.toHaveBeenCalled();
  });

  it('records collected misses with the exact collection time rather than sampling the audio again', () => {
    const { scene, recorder, chart } = recordingHarness();
    const nowMs = chart.notes[0].atMs + 148.625; // Viral's 148ms good window has just elapsed.
    const clock = vi.spyOn(scene, 'clockMs');
    scene.collectHumanMisses(nowMs);
    expect(recorder.toRecording().events).toHaveLength(1);
    expect(recorder.toRecording().events[0]).toMatchObject({ atMs: nowMs,
      judgement: { grade: 'miss', noteId: chart.notes[0].id, offsetMs: 148.625 } });
    expect(clock).not.toHaveBeenCalled();
  });

  it('timestamps received online judgements at the local presentation clock, preserving judgement offset separately', () => {
    const { scene, recorder, chart } = recordingHarness();
    const note = chart.notes[0];
    const nowMs = note.atMs + 500.75;
    scene.online = { localSlot: 1, matchSerial: 7 };
    scene.soundManager.getBattleMusicClockSample.mockReturnValue({
      status: 'playing', positionMs: nowMs, durationMs: null, loop: false,
    });
    scene.onOnlineControl({ t: 'aura_judgement', matchSerial: 7, noteId: note.id, grade: 'great', offsetMs: 80.25 });
    expect(recorder.toRecording().events[0]).toMatchObject({ atMs: nowMs,
      judgement: { noteId: note.id, grade: 'great', offsetMs: 80.25 } });
    expect(scene.soundManager.getBattleMusicClockSample).toHaveBeenCalledOnce();
  });

  it('ignores pre-roll and paused input without poisoning or appending to the real journal', () => {
    const { scene, recorder } = recordingHarness();
    const judge = vi.spyOn(scene.battle, 'judgeInput');
    scene.clockStartedAt = null;
    scene.handleInput(0, 0);
    scene.handleInput(0, 0, -1);
    scene.clockStartedAt = 0;
    scene.paused = true;
    scene.handleInput(0, 0);
    scene.handleInput(0, 0, 50);
    expect(judge).not.toHaveBeenCalled();
    expect(scene.flashLaneInput).not.toHaveBeenCalled();
    expect(recorder.toRecording()).toMatchObject({ status: 'recording', failure: null, events: [] });
    scene.paused = false;
    scene.handleInput(0, 0, 0);
    expect(recorder.toRecording().events[0]).toMatchObject({ atMs: 0, judgement: { grade: 'wrong_turn' } });
  });

  it('disables incomplete action history on recorder failure without aborting gameplay feedback', () => {
    const { scene, recorder, chart } = recordingHarness();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const judgement = scene.battle.judgeNote(chart.notes[0].id, 'perfect', 0);
    scene.recordJudgement(judgement, 100);
    expect(() => scene.applyJudgement(judgement, false, 99)).not.toThrow();
    expect(scene.actionRecorder).toBeNull();
    expect(recorder.toRecording()).toMatchObject({ status: 'failed', failure: 'invalid-event' });
    expect(recorder.toRecording().events).toHaveLength(1);
    expect(scene.showFeedback).toHaveBeenCalledWith(judgement);
    expect(scene.updateScoreUi).toHaveBeenCalledOnce();
    scene.applyJudgement(judgement, false, 101);
    expect(recorder.toRecording().events).toHaveLength(1);
  });

  it.each([false, true])('waits for usable presentation after async create, with initial readiness=%s', ready => {
    const { scene } = harness();
    const staleAdvance = vi.fn(() => { throw new Error('Old sprite texture was destroyed'); });
    const readyAdvance = vi.fn();
    Object.assign(scene, { lifecycleActive: true, presentationReady: ready, paused: false, clockStartedAt: null,
      advanceFighterPresentation: ready ? readyAdvance : staleAdvance,
      soundManager: { updateAuraCrowd: vi.fn() },
    });
    expect(() => scene.update(0, 16)).not.toThrow();
    expect(staleAdvance).not.toHaveBeenCalled();
    expect(readyAdvance).toHaveBeenCalledTimes(ready ? 1 : 0);
    expect(scene.soundManager.updateAuraCrowd).toHaveBeenCalledTimes(ready ? 1 : 0);

    // Async loading has replaced the stale views before opening the gate.
    scene.advanceFighterPresentation = readyAdvance;
    scene.presentationReady = true;
    scene.update(16, 16);
    expect(staleAdvance).not.toHaveBeenCalled();
    expect(readyAdvance).toHaveBeenCalledTimes(ready ? 2 : 1);
    expect(readyAdvance).toHaveBeenLastCalledWith(0.016);
  });

  it.each([false, true])('surfaces a video encoder error once while paused, with presentation readiness=%s', presentationReady => {
    const { scene } = harness();
    Object.assign(scene, { lifecycleActive: true, presentationReady, paused: true, captureId: 'current', captureErrorReported: false,
      videoRecorder: { error: 'recording-duration-limit' }, emitCapture: vi.fn(),
      advanceFighterPresentation: vi.fn(),
    });
    scene.update(0, 16);
    scene.update(16, 16);
    expect(scene.emitCapture).toHaveBeenCalledExactlyOnceWith({
      id: 'current', state: 'unavailable', reason: 'recording-duration-limit',
    });
    expect(scene.advanceFighterPresentation).not.toHaveBeenCalled();
  });

  it('pauses/resumes video and game audio together, ignoring duplicate, online and post-match pause events', () => {
    const scene = Object.assign(new AuraScene(), harness().scene);
    Object.assign(scene, { online: null, paused: false, pausedDuration: 0,
      videoRecorder: { pause: vi.fn(), resume: vi.fn() },
      soundManager: { pauseBattleMusic: vi.fn(), resumeBattleMusic: vi.fn() },
    });
    const clock = vi.spyOn(globalThis.performance, 'now').mockReturnValue(100);
    scene.onPause({ detail: { paused: true } });
    scene.onPause({ detail: { paused: true } });
    clock.mockReturnValue(400);
    scene.onPause({ detail: { paused: false } });
    scene.onPause({ detail: { paused: false } });
    expect(scene.pausedDuration).toBe(300);
    expect(scene.videoRecorder.pause).toHaveBeenCalledOnce();
    expect(scene.videoRecorder.resume).toHaveBeenCalledOnce();
    expect(scene.soundManager.pauseBattleMusic).toHaveBeenCalledOnce();
    expect(scene.soundManager.resumeBattleMusic).toHaveBeenCalledOnce();
    scene.matchFinished = true;
    scene.onPause({ detail: { paused: true } });
    scene.matchFinished = false;
    scene.online = { localSlot: 0, matchSerial: 1 };
    scene.onPause({ detail: { paused: true } });
    expect(scene.paused).toBe(false);
    expect(scene.videoRecorder.pause).toHaveBeenCalledOnce();
  });

  it('ignores a stale finalization callback before it can stop a new match recording', async () => {
    const { scene } = harness();
    Object.assign(scene, { lifecycleActive: true, lifecycleEpoch: 3, captureId: 'new',
      videoRecorder: { stop: vi.fn().mockResolvedValue(null) }, emitCapture: vi.fn(),
    });
    await scene.finishVideoCapture(1);
    expect(scene.videoRecorder.stop).not.toHaveBeenCalled();
    expect(scene.emitCapture).not.toHaveBeenCalled();
  });

  it('destroys capture on scene cleanup and cannot publish a late async result into the next match', async () => {
    vi.stubGlobal('window', { removeEventListener: vi.fn() });
    const scene = Object.assign(new AuraScene(), harness().scene);
    let resolveStop!: (video: AuraVideoRecording | null) => void;
    const oldVideo = { stop: vi.fn(() => new Promise<AuraVideoRecording | null>(resolve => { resolveStop = resolve; })), destroy: vi.fn() };
    const unsubscribe = vi.fn();
    Object.assign(scene, { lifecycleActive: true, lifecycleEpoch: 1, captureId: 'old',
      videoRecorder: oldVideo, actionRecorder: {}, emitCapture: vi.fn(), clearNotes: vi.fn(),
      comicFeedback: { destroy: vi.fn() }, auraPerformanceViews: [null, null], auraAnimationPacks: [null, null],
      soundManager: { destroy: vi.fn(), pauseBattleMusic: vi.fn() },
      keyBindings: [], onlineUnsubscribe: [unsubscribe], online: null, customStageTextureKey: null,
    });
    const completion = scene.finishVideoCapture(1);
    scene.onLifecycleEnd();
    expect(oldVideo.destroy).toHaveBeenCalledOnce();
    expect(scene.videoRecorder).toBeNull();
    expect(scene.actionRecorder).toBeNull();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(scene.lifecycleEpoch).toBe(2);
    expect(scene.presentationReady).toBe(false);
    scene.lifecycleActive = true;
    scene.lifecycleEpoch = 3;
    scene.captureId = 'new';
    const newVideo = { stop: vi.fn(), destroy: vi.fn() };
    scene.videoRecorder = newVideo;
    resolveStop({ blob: new Blob(['old frame']), mimeType: 'video/webm', hasAudio: false });
    await completion;
    expect(scene.emitCapture).not.toHaveBeenCalled();
    expect(scene.soundManager.pauseBattleMusic).not.toHaveBeenCalled();
    expect(newVideo.stop).not.toHaveBeenCalled();
    expect(newVideo.destroy).not.toHaveBeenCalled();
  });
});

function controlText() {
  return {
    text: '', visible: false, color: '', x: 0, y: 0, scale: 1, width: 120,
    setText(value: string) { this.text = value; return this; },
    setVisible(value: boolean) { this.visible = value; return this; },
    setColor(value: string) { this.color = value; return this; },
    setPosition(x: number, y: number) { this.x = x; this.y = y; return this; },
    setX(value: number) { this.x = value; return this; },
    setY(value: number) { this.y = value; return this; },
    setFontSize: vi.fn().mockReturnThis(),
    setOrigin: vi.fn().mockReturnThis(),
    setScale(value: number) { this.scale = value; return this; },
    setAlpha: vi.fn().mockReturnThis(),
  };
}

function controlGraphics() {
  return Object.fromEntries(['clear', 'fillStyle', 'fillRect', 'lineStyle', 'lineBetween',
    'fillPoints', 'strokePoints', 'setAlpha', 'setScale', 'setPosition', 'setVisible'].map(name => [name, vi.fn().mockReturnThis()]));
}

describe('AuraScene score and precision hierarchy', () => {
  it('keeps the actual delta at the HUD and only precision over the notes, ignoring late rival feedback', () => {
    const textValues: string[] = [];
    const scene = Object.assign(Object.create(AuraScene.prototype), {
      layout: createAuraLayout(), activePerformerSlot: 0, reduceMotion: false, difficultyId: 'viral',
      scoreFeedback: { show: vi.fn() }, uiLayer: { add: vi.fn() }, feedbackObject: null,
      tweens: { add: vi.fn(), killTweensOf: vi.fn() },
      add: {
        container: () => ({ add: vi.fn(), destroy: vi.fn(), setDepth: vi.fn().mockReturnThis(), setAlpha: vi.fn().mockReturnThis() }),
        graphics: controlGraphics,
        text: (_x: number, _y: number, value: string) => {
          textValues.push(value);
          return { ...controlText(), height: 13 };
        },
      },
    });
    const hit = { slot: 0, grade: 'perfect', scoreDelta: 1_250, noteId: 'n1', offsetMs: 24, combo: 20 };
    scene.showFeedback(hit);
    expect(scene.scoreFeedback.show).toHaveBeenCalledExactlyOnceWith(1_250, { x: 24, y: 62, originX: 0 });
    expect(textValues).toEqual(['PERFECT', 'LATE 24MS']);
    scene.showFeedback({ ...hit, slot: 1 });
    expect(textValues).toEqual(['PERFECT', 'LATE 24MS']);
    expect(scene.scoreFeedback.show).toHaveBeenCalledOnce();
    scene.showFeedback({ ...hit, grade: 'wrong_turn', slot: 1, noteId: null });
    expect(textValues.at(-1)).toBe('WAIT YOUR TURN');
    expect(scene.scoreFeedback.show).toHaveBeenCalledOnce();
  });
});

function controlsHarness(options: { isVsAI?: boolean; cpuVsCpu?: boolean; online?: { localSlot: 0 | 1 } } = {}) {
  return Object.assign(Object.create(AuraScene.prototype), {
    layout: createAuraLayout(), fitHudText: vi.fn(),
    matchData: {},
    isVsAI: true, cpuVsCpu: false, online: null, ...options,
    chart: { turns: [{ slot: 0 }, { slot: 1 }], noteTravelMs: 2_000 },
    difficultyId: 'viral', reduceMotion: true, comicFeedback: { beginTurn: vi.fn() },
    fighters: [{ x: 250 }, { x: 774 }], activePerformerSlot: null,
    clearNotes: vi.fn(), drawHighwayFrame: vi.fn(), drawBeatGrid: vi.fn(),
    updateCrowdUi: vi.fn(), focusBoth: vi.fn(), focusPerformer: vi.fn(),
    laneGraphics: controlGraphics(), targetGraphics: controlGraphics(),
    inputFlashGraphics: Array.from({ length: 4 }, controlGraphics),
    inputPulseGraphics: Array.from({ length: 4 }, controlGraphics),
    laneKeyTexts: Array.from({ length: 4 }, controlText), highwayMetaText: controlText(),
    highwayTitleText: controlText(), comboText: controlText(),
    tweens: { killTweensOf: vi.fn(), add: vi.fn() },
  });
}

describe('AuraScene persistent controls', () => {
  it.each([
    { title: 'human turn', options: {}, turn: 0, keys: AURA_DEFAULT_LANE_KEYS, hint: 'YOUR TURN · HIT THE SHAPES' },
    { title: 'CPU turn', options: {}, turn: 1, keys: AURA_DEFAULT_LANE_KEYS, hint: 'CPU TURN · GET READY' },
    { title: 'local P1', options: { isVsAI: false }, turn: 0, keys: AURA_LOCAL_P1_LANE_KEYS, hint: 'P1 TURN · A S D F' },
    { title: 'local P2', options: { isVsAI: false }, turn: 1, keys: AURA_LOCAL_P2_LANE_KEYS, hint: 'P2 TURN · J K L ;' },
    { title: 'online local P2', options: { online: { localSlot: 1 as const } }, turn: 1, keys: AURA_DEFAULT_LANE_KEYS, hint: 'YOUR TURN · HIT THE SHAPES' },
    { title: 'online rival', options: { online: { localSlot: 1 as const } }, turn: 0, keys: AURA_DEFAULT_LANE_KEYS, hint: 'RIVAL TURN · GET READY' },
    { title: 'watch CPU 1', options: { cpuVsCpu: true }, turn: 0, keys: ['1', '2', '3', '4'], hint: 'AUTO · CPU 1 TURN' },
    { title: 'watch CPU 2', options: { cpuVsCpu: true }, turn: 1, keys: ['1', '2', '3', '4'], hint: 'AUTO · CPU 2 TURN' },
  ])('keeps aligned, high-contrast lane references for $title', ({ options, turn, keys, hint }) => {
    const scene = controlsHarness(options);
    scene.updateTurnPresentation(turn);
    expect(scene.laneKeyTexts.map((text: ReturnType<typeof controlText>) => text.text)).toEqual(keys);
    expect(scene.laneKeyTexts.map((text: ReturnType<typeof controlText>) => [text.visible, text.color, text.x, text.y]))
      .toEqual(scene.layout.laneOffsets.map((offset: number) => [true, '#fff4d6', scene.layout.highwayX + offset, scene.layout.keyLabelY]));
    expect(scene.highwayMetaText.text).toBe(hint);
    expect(scene.highwayMetaText.visible).toBe(true);
    expect([scene.highwayMetaText.x, scene.highwayMetaText.y]).toEqual([scene.layout.highwayX, scene.layout.keyLabelY + 47]);
  });

  it('teaches controls during the initial count-in and preserves them through CPU handoff', () => {
    const scene = controlsHarness();
    scene.updateTurnPresentation(-1);
    expect(scene.highwayMetaText.text).toBe('GET READY · D F J K');
    expect(scene.laneKeyTexts.every((text: ReturnType<typeof controlText>) => text.visible)).toBe(true);
    scene.updateTurnPresentation(0);
    scene.updateTurnPresentation(1);
    expect(scene.laneKeyTexts.map((text: ReturnType<typeof controlText>) => text.text)).toEqual(AURA_DEFAULT_LANE_KEYS);
    expect(scene.laneKeyTexts.every((text: ReturnType<typeof controlText>) => text.visible)).toBe(true);
    expect(scene.highwayMetaText.text).toBe('CPU TURN · GET READY');
    scene.updateTurnPresentation(2);
    expect(scene.laneKeyTexts.every((text: ReturnType<typeof controlText>) => !text.visible)).toBe(true);
    expect(scene.highwayMetaText.visible).toBe(false);
    expect(scene.comicFeedback.beginTurn).toHaveBeenCalledTimes(4);
  });

  it('keeps the existing input bindings and feedback paths unchanged', () => {
    const scene = controlsHarness({ isVsAI: false });
    const keys = new Map<string, { on: ReturnType<typeof vi.fn> }>();
    scene.input = { keyboard: {
      addKey: (key: string) => {
        const binding = { on: vi.fn() }; keys.set(key, binding); return binding;
      },
      addCapture: vi.fn(),
    } };
    scene.createInput();
    expect([...keys.keys()]).toEqual([...AURA_LOCAL_P1_LANE_KEYS, ...AURA_LOCAL_P2_LANE_KEYS]);
    expect(scene.keyBindings).toHaveLength(8);
    scene.handleInput = vi.fn();
    scene.keyBindings[0].handler();
    scene.keyBindings[7].handler();
    expect(scene.handleInput.mock.calls).toEqual([[0, 0], [1, 3]]);
  });
});

function performerContainer() {
  return {
    x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true, alpha: 1,
    setPosition(x: number, y: number) { this.x = x; this.y = y; return this; },
    setScale(value: number) { this.scaleX = value; this.scaleY = value; return this; },
    setVisible(value: boolean) { this.visible = value; return this; },
    setAlpha(value: number) { this.alpha = value; return this; },
  };
}

function cameraHarness(width = 1024, height = 576) {
  const result = harness();
  const { scene } = result;
  delete scene.applyPerformerLayout;
  const bodies = [{ rootX: 250, rootY: 480, height: 230 }, { rootX: 774, rootY: 480, height: 230 }];
  Object.assign(scene, {
    layout: createAuraLayout(width, height), resolvedStageId: DEFAULT_AURA_STAGE_ID,
    performerContainers: [performerContainer(), performerContainer()], stageGrade: controlGraphics(),
    stageBackdrop: {
      frame: { realWidth: 1672, realHeight: 941 }, x: 0, y: 0, displayWidth: 0, displayHeight: 0,
      setPosition(x: number, y: number) { Object.assign(this, { x, y }); return this; },
      setDisplaySize(displayWidth: number, displayHeight: number) { Object.assign(this, { displayWidth, displayHeight }); return this; },
    },
  });
  scene.views.forEach((view: Record<string, unknown>, slot: number) => { view.getIdleBodyReference = () => bodies[slot]; });
  scene.playerTags.forEach((tag: Record<string, unknown>) => { tag.setVisible = vi.fn(); });
  Object.assign(scene.comicFeedback, { setAnchor: vi.fn(), setSlotVisible: vi.fn() });
  scene.layoutStage();
  scene.applyPerformerLayout();
  return { ...result, bodies };
}

describe('AuraScene responsive whole-rig layout', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([[1024, 576], [576, 1024]])('pans both visible bodies at the midpoint while notes stay fixed and the authored floor stays anchored at %i×%i', (width, height) => {
    const { scene } = cameraHarness(width, height);
    const chart = createAuraChart(67, 'viral', DEFAULT_AURA_TRACK);
    const note = chart.turns[1].notes[0];
    const markers = new Map<string, any>();
    Object.assign(scene, {
      chart, difficultyId: 'viral', battle: new AuraBattle(chart), noteObjects: markers, finalizing: false,
      createNote: (id: string) => {
        const marker = Object.assign(controlText(), { setAlpha() { return this; }, destroy: vi.fn() });
        markers.set(id, marker);
        return marker;
      },
    });
    scene.updateNotes(note.atMs);
    const marker = markers.get(note.id);
    const notePosition = { x: marker.x, y: marker.y };
    const lanes = [0, 1, 2, 3].map(lane => scene.laneLayout(0, lane));
    const backdropX = scene.stageBackdrop.x;
    const before = scene.cameraComposition();
    scene.focusPerformer(1);
    expect(scene.cameraComposition().performers).toEqual(before.performers);
    expect(scene.performerNameText.visible).toBe(false);
    scene.advanceCameraPresentation(AURA_CAMERA_HANDOFF_MS / 2);
    expect(scene.performerContainers.map((rig: ReturnType<typeof performerContainer>) => [rig.visible, rig.alpha]))
      .toEqual([[true, 1], [true, 1]]);
    expect(scene.stageBackdrop.x).not.toBe(backdropX);
    expect(scene.stageBackdrop.y + (0.82 - 0.5) * scene.stageBackdrop.displayHeight).toBeCloseTo(scene.layout.active.footY, 10);
    scene.updateNotes(note.atMs);
    expect(marker).toMatchObject(notePosition);
    expect([0, 1, 2, 3].map(lane => scene.laneLayout(1, lane))).toEqual(lanes);
    expect(scene.cameraTransitionMs).toBe(AURA_CAMERA_HANDOFF_MS / 2);
    scene.advanceCameraPresentation(AURA_CAMERA_HANDOFF_MS / 2);
    expect(scene.performerContainers.map((rig: ReturnType<typeof performerContainer>) => [rig.visible, rig.alpha]))
      .toEqual([[false, 0], [true, 1]]);
    expect(scene.stageBackdrop.x).toBeLessThan(backdropX);
    expect(scene.performerNameText).toMatchObject({ text: 'P2 · P2', visible: true });
  });

  it('does not restart an authored animation or its handoff when a frame is rendered again or reflowed', () => {
    const { scene, performance, waiting } = cameraHarness();
    scene.focusPerformer(1);
    scene.auraPerformanceViews[1].play('aura_six_seven');
    scene.advanceCameraPresentation(180);
    const cameraTime = scene.cameraTransitionMs;
    const restingCalls = [performance.playResting.mock.calls.length, waiting.playResting.mock.calls.length];
    const initial = scene.fighters.map((fighter: Fighter) => fighter.snapshot());
    for (let frame = 0; frame < 6; frame++) scene.applyPerformerLayout();
    expect(scene.cameraTransitionMs).toBe(cameraTime);
    expect([performance.playResting.mock.calls.length, waiting.playResting.mock.calls.length]).toEqual(restingCalls);
    expect(waiting.play).toHaveBeenCalledExactlyOnceWith('aura_six_seven');
    expect(performance.playFinale).not.toHaveBeenCalled();
    expect(waiting.playFinale).not.toHaveBeenCalled();
    expect(scene.fighters.map((fighter: Fighter) => fighter.snapshot())).toEqual(initial);
    scene.layout = createAuraLayout(576, 1024);
    scene.layoutStage();
    scene.applyPerformerLayout();
    expect(scene.cameraTransitionMs).toBe(cameraTime);
    expect(scene.cameraFocusSlot).toBe(1);
    expect(scene.cameraFromSlot).toBe(0);
    expect(waiting.play).toHaveBeenCalledOnce();
  });

  it('freezes the pan and both animation clocks while paused, then advances only the resumed frame delta', () => {
    const { scene, performance, waiting } = cameraHarness();
    Object.assign(scene, { lifecycleActive: true, presentationReady: true, clockStartedAt: null });
    Object.assign(scene.soundManager, { updateAuraCrowd: vi.fn() });
    scene.focusPerformer(1);
    scene.update(0, 90);
    expect(scene.cameraTransitionMs).toBe(90);
    const frozen = scene.cameraComposition();
    const animationCalls = [performance.update.mock.calls.length, waiting.update.mock.calls.length];
    scene.paused = true;
    scene.update(90, 5_000);
    expect(scene.cameraComposition()).toEqual(frozen);
    expect([performance.update.mock.calls.length, waiting.update.mock.calls.length]).toEqual(animationCalls);
    scene.paused = false;
    scene.update(5090, 20);
    expect(scene.cameraTransitionMs).toBe(110);
    expect(waiting.update).toHaveBeenLastCalledWith(20, scene.views[1]);
  });

  it('snaps directly to the new subject under reduced motion', () => {
    const { scene } = cameraHarness();
    scene.reduceMotion = true;
    scene.focusPerformer(1);
    expect(scene.cameraTransitionMs).toBe(AURA_CAMERA_HANDOFF_MS);
    expect(scene.cameraComposition().camera.zoom).toBe(1);
    expect(scene.performerContainers.map((rig: ReturnType<typeof performerContainer>) => [rig.visible, rig.alpha]))
      .toEqual([[false, 0], [true, 1]]);
    expect(scene.tweens.add).not.toHaveBeenCalled();
  });

  it.each([
    { winner: 'p1', scoringSlot: 0, reducedMotion: false },
    { winner: 'p2', scoringSlot: 1, reducedMotion: false },
    { winner: 'draw', scoringSlot: null, reducedMotion: false },
    { winner: 'p1', scoringSlot: 0, reducedMotion: true },
  ])('reunites both bodies for $winner with winner/defeat poses and a readable finale, reduced=$reducedMotion', ({ winner, scoringSlot, reducedMotion }) => {
    vi.useFakeTimers();
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const { scene, bodies } = cameraHarness();
    const chart = createAuraChart(67, 'viral', DEFAULT_AURA_TRACK);
    const battle = new AuraBattle(chart);
    if (scoringSlot !== null) battle.judgeNote(chart.notes.find(note => note.slot === scoringSlot)!.id, 'perfect');
    Object.assign(scene, {
      chart, battle, track: DEFAULT_AURA_TRACK, difficultyId: 'viral', resolvedStageId: DEFAULT_AURA_STAGE_ID,
      stageLabel: 'AURA PLAZA', p1Name: 'P1', p2Name: 'P2', customStageKey: null,
      turnText: controlText(), phaseText: controlText(), comboText: controlText(), lifecycleEpoch: 1, captureId: 'finale-test',
      online: null, isVsAI: true, cpuVsCpu: false, videoRecorder: null,
      cameraFocusSlot: 1, cameraFromSlot: winner === 'p1' && !reducedMotion ? 0 : 1, reduceMotion: reducedMotion,
      cameraTransitionMs: winner === 'p1' && !reducedMotion ? AURA_CAMERA_HANDOFF_MS / 2 : AURA_CAMERA_HANDOFF_MS,
      finishVideoCapture: vi.fn(), setMatchActionsVisible: vi.fn(),
      time: { delayedCall: vi.fn((delay: number, callback: () => void) => setTimeout(callback, delay)) },
    });
    Object.assign(scene.soundManager, { playAnnounce: vi.fn(), peakAuraCrowd: vi.fn() });
    const before = scene.cameraComposition();
    const handoffTime = scene.cameraTransitionMs;
    scene.completeMatch();
    expect(scene.activePerformerSlot).toBe(scoringSlot);
    expect(scene.comboText.visible).toBe(false);
    expect(scene.renderDuelScoreUi).toHaveBeenCalledExactlyOnceWith(battle.scoreFor(0).score, battle.scoreFor(1).score);
    if (!reducedMotion) expect(scene.cameraComposition().performers).toEqual(before.performers);
    scene.advanceCameraPresentation(AURA_CAMERA_FINALE_MS);
    expect(scene.cameraTransitionMs).toBe(handoffTime);
    expect(scene.performerContainers.map((rig: ReturnType<typeof performerContainer>) => rig.visible)).toEqual([true, true]);
    expect(dispatchEvent.mock.calls[0][0].detail.winnerSlot).toBe(winner);
    scene.advanceFighterPresentation(1 / 60);
    for (const slot of [0, 1] as const) {
      const placement = scene.cameraComposition().performers[slot];
      const rig = scene.performerContainers[slot];
      expect(bodies[slot].rootX * rig.scaleX + rig.x).toBeCloseTo(placement.x, 10);
      expect(bodies[slot].rootY * rig.scaleY + rig.y).toBeCloseTo(placement.footY, 10);
      const won = winner === 'draw' || scoringSlot === slot;
      expect(scene.fighters[slot].state).toBe(won ? FighterState.VICTORY : FighterState.DEFEAT);
      expect(scene.auraPerformanceViews[slot].playFinale).toHaveBeenCalledExactlyOnceWith(won);
      expect(scene.auraPerformanceViews[slot].update).toHaveBeenLastCalledWith(1_000 / 60, scene.views[slot]);
    }
    expect(scene.cameraFocusSlot).toBe(1); // Winning P1 must not cut away from the last camera mark.
    const resultsDelay = reducedMotion ? 1_800 : 3_000;
    vi.advanceTimersByTime(resultsDelay - 1);
    expect(scene.setMatchActionsVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(scene.setMatchActionsVisible).toHaveBeenCalledExactlyOnceWith(true);
    expect(scene.time.delayedCall).toHaveBeenCalledWith(2_800, expect.any(Function));
    vi.advanceTimersByTime(2_800);
    expect(scene.finishVideoCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    { width: 1024, height: 576, x: 942, y: 539, meterY: 550 },
    { width: 576, height: 1024, x: 430, y: 599, meterY: 610 },
  ])('keeps the active crowd counter in one right-aligned area at $width×$height', ({ width, height, x, y, meterY }) => {
    const { scene } = harness();
    delete scene.updateCrowdUi;
    Object.assign(scene, { layout: createAuraLayout(width, height), crowdHeat: [0.2, 0.95],
      crowdLabelText: controlText(), crowdMeterGraphics: controlGraphics(),
    });
    scene.updateCrowdUi(0);
    expect(scene.crowdLabelText).toMatchObject({ x, y, text: height > width ? 'WARMING UP' : 'CROWD · WARMING UP', visible: true });
    scene.updateCrowdUi(1);
    expect(scene.crowdLabelText).toMatchObject({ x, y, text: height > width ? 'UNHINGED' : 'CROWD · UNHINGED', visible: true });
    expect(scene.crowdLabelText.setOrigin.mock.calls).toEqual([[1, 0], [1, 0]]);
    expect(scene.crowdMeterGraphics.fillRect).toHaveBeenCalledTimes(16);
    for (const [, segmentY, , segmentHeight] of scene.crowdMeterGraphics.fillRect.mock.calls) {
      expect(segmentY).toBe(meterY + 2);
      expect(segmentY + segmentHeight).toBeLessThan(height);
    }
    scene.updateCrowdUi(null);
    expect(scene.crowdLabelText.visible).toBe(false);
    expect(scene.crowdMeterGraphics.setVisible).toHaveBeenLastCalledWith(false);
  });

  it.each([
    { width: 1024, height: 576, x: 942, y: 189, origin: 1, fontSize: 11 },
    { width: 576, height: 1024, x: 532, y: 599, origin: 1, fontSize: 11 },
  ])('groups FLOW within the rhythm instrument at $width×$height', ({ width, height, x, y, origin, fontSize }) => {
    const { scene } = harness();
    const camera = () => Object.fromEntries(['setViewport', 'setZoom', 'setScroll']
      .map(name => [name, vi.fn().mockReturnThis()]));
    Object.assign(scene, {
      layout: createAuraLayout(width, height), layoutStage: vi.fn(), cameras: { main: camera() }, uiCamera: camera(),
      hudPanel: controlGraphics(), crtOverlay: controlGraphics(), beatGraphics: controlGraphics(),
      duelMeterGraphics: controlGraphics(), duelHeadingText: controlText(), performerNameText: controlText(),
      p1NameText: controlText(), p2NameText: controlText(), p1ScoreText: controlText(), p2ScoreText: controlText(),
      turnText: controlText(), phaseText: controlText(), countInText: controlText(), comboText: controlText(),
      drawLanes: vi.fn(), feedbackObject: null,
    });
    scene.applyLayout();
    expect(scene.comboText).toMatchObject({ x, y });
    expect(scene.comboText.setOrigin).toHaveBeenCalledExactlyOnceWith(origin, 0);
    expect(scene.comboText.setFontSize).toHaveBeenCalledExactlyOnceWith(fontSize);
    const instrument = scene.layout.instrument;
    const flowWidth = 'x999 FLOW'.length * fontSize;
    expect(scene.comboText.x - flowWidth).toBeGreaterThan(instrument.left);
    expect(scene.comboText.x).toBeLessThan(instrument.right);
    expect(scene.comboText.y).toBeGreaterThan(instrument.top);
    expect(scene.comboText.y + fontSize).toBeLessThan(scene.layout.laneStartY);
  });

  it.each([[1024, 576], [576, 1024]])('aligns approaching notes, receptors, keycaps and press feedback at %i×%i', (width, height) => {
    const scene = controlsHarness({ online: { localSlot: 1 } });
    const chart = createAuraChart(67, 'viral');
    const note = chart.turns[0].notes[0];
    const marker = { setPosition: vi.fn().mockReturnThis(), setScale: vi.fn().mockReturnThis(),
      setAlpha: vi.fn().mockReturnThis(), destroy: vi.fn() };
    Object.assign(scene, { layout: createAuraLayout(width, height), chart, finalizing: false,
      battle: { isJudged: () => false }, noteObjects: new Map(), createNote: () => marker,
      time: { delayedCall: vi.fn() },
    });
    scene.drawLanes(0);
    scene.updateNotes(note.atMs);
    const x = scene.layout.highwayX + scene.layout.laneOffsets[note.lane];
    expect(marker.setPosition).toHaveBeenCalledWith(x, scene.layout.laneTargetY);
    scene.flashLaneInput(0, note.lane);
    expect(scene.inputPulseGraphics[note.lane].setPosition).toHaveBeenCalledExactlyOnceWith(x, scene.layout.laneTargetY);
    expect(scene.inputFlashGraphics[note.lane].fillRect).toHaveBeenCalledWith(
      x - 30, scene.layout.laneStartY, 60, scene.layout.laneTargetY - scene.layout.laneStartY,
    );
    expect(scene.laneKeyTexts[note.lane]).toMatchObject({ x, y: scene.layout.keyLabelY });
    expect(scene.laneKeyTexts.map((text: ReturnType<typeof controlText>) => text.text)).toEqual(AURA_DEFAULT_LANE_KEYS);
    expect(scene.highwayMetaText.text).toBe('RIVAL TURN · GET READY');
    // A later local turn uses the same device bindings, not the actor's screen side.
    scene.drawLaneControlHints(1);
    expect(scene.laneKeyTexts.map((text: ReturnType<typeof controlText>) => text.text)).toEqual(AURA_DEFAULT_LANE_KEYS);
    expect(scene.highwayMetaText.text).toBe('YOUR TURN · HIT THE SHAPES');
  });

  it.each([[1024, 576], [576, 1024]])('places both rigs around their own physical idle feet without ticking at %i×%i', (width, height) => {
    const { scene } = harness();
    delete scene.applyPerformerLayout;
    scene.layout = createAuraLayout(width, height);
    scene.performerContainers = [performerContainer(), performerContainer()];
    const bodies = [{ rootX: 253.5, rootY: 465.25, height: 230.5 }, { rootX: 768.25, rootY: 471.5, height: 217 }];
    scene.views.forEach((view: Record<string, unknown>, slot: number) => {
      view.getIdleBodyReference = vi.fn(() => bodies[slot]);
    });
    scene.playerTags.forEach((tag: Record<string, unknown>) => { tag.setVisible = vi.fn(); });
    Object.assign(scene.comicFeedback, { setAnchor: vi.fn(), setSlotVisible: vi.fn() });
    const initial = scene.fighters.map((fighter: Fighter) => fighter.snapshot());
    const laneXs = scene.layout.laneOffsets.map((offset: number) => scene.layout.highwayX + offset);
    for (const activeSlot of [0, 1, null] as const) {
      if (activeSlot === null) scene.focusBoth();
      else scene.focusPerformer(activeSlot);
      scene.advanceCameraPresentation(AURA_CAMERA_HANDOFF_MS);
      for (const slot of [0, 1] as const) {
        const placement = scene.cameraComposition().performers[slot];
        const transform = auraPerformerTransform(bodies[slot], placement);
        expect(scene.performerContainers[slot]).toMatchObject({
          x: transform.x, y: transform.y, scaleX: transform.scale, scaleY: transform.scale, visible: placement.visible, alpha: placement.alpha,
        });
        expect(scene.playerTags[slot].setVisible).toHaveBeenLastCalledWith(false);
        expect(scene.comicFeedback.setAnchor).toHaveBeenCalledWith(slot, auraComicAnchor(scene.layout, slot));
        expect(scene.comicFeedback.setSlotVisible).toHaveBeenCalledWith(slot, activeSlot === slot);
      }
      expect(scene.performerContainers.map((rig: ReturnType<typeof performerContainer>) => rig.visible))
        .toEqual(scene.cameraFocusSlot === 1 ? [false, true] : [true, false]);
      expect(scene.layout.laneOffsets.map((offset: number) => scene.layout.highwayX + offset)).toEqual(laneXs);
      const activePlacement = scene.cameraComposition().performers[activeSlot ?? 0];
      if (activeSlot !== null) expect(scene.activeGlow.setPosition).toHaveBeenLastCalledWith(activePlacement.x, activePlacement.footY);
      expect(scene.activeGlow.setAlpha).toHaveBeenLastCalledWith(activeSlot === null ? 0 : 1);
    }
    expect(scene.fighters.map((fighter: Fighter) => fighter.snapshot())).toEqual(initial);
    scene.fighters.forEach((fighter: Fighter) => expect(fighter.update).not.toHaveBeenCalled());
    expect(scene.tweens.add).not.toHaveBeenCalled();
  });

  it.each([false, true])('reflows the same match and capture on rotation, including paused=%s', paused => {
    const scene = Object.assign(new AuraScene(), harness().scene);
    const chart = scene.chart;
    const videoRecorder = { destroy: vi.fn(), start: vi.fn(), stop: vi.fn() };
    Object.assign(scene, { lifecycleActive: true, presentationReady: true, paused,
      scale: { width: 576, height: 1024 }, applyLayout: vi.fn(), updateNotes: vi.fn(),
      captureId: 'same-recording', videoRecorder,
    });
    const initial = scene.fighters.map((fighter: Fighter) => fighter.snapshot());
    const clock = scene.musicClock;
    scene.onLayoutResize();
    expect(scene.layout).toEqual(createAuraLayout(576, 1024));
    expect(scene.applyLayout).toHaveBeenCalledOnce();
    expect(scene.comicFeedback.beginTurn).toHaveBeenCalledOnce();
    expect(scene.chart).toBe(chart);
    expect(scene.musicClock).toBe(clock);
    expect(scene.matchSeed).toBe(67);
    expect(scene.captureId).toBe('same-recording');
    expect(scene.videoRecorder).toBe(videoRecorder);
    expect(scene.fighters.map((fighter: Fighter) => fighter.snapshot())).toEqual(initial);
    expect(videoRecorder.destroy).not.toHaveBeenCalled();
    expect(videoRecorder.start).not.toHaveBeenCalled();
    expect(videoRecorder.stop).not.toHaveBeenCalled();
  });

  it('reprojects existing notes during a paused rotation at the frozen music instant', () => {
    const scene = Object.assign(new AuraScene(), harness().scene);
    const chart = createAuraChart(67, 'viral');
    const note = chart.turns[0].notes[0];
    const nowMs = note.atMs - Math.min(250, note.atMs - chart.turns[0].startMs);
    const clock = new AuraMusicClock();
    clock.update(nowMs, { status: 'playing', positionMs: nowMs, durationMs: null, loop: false });
    const sampleClock = vi.spyOn(clock, 'update');
    const notes = new Map<string, ReturnType<typeof controlText> & { setAlpha: () => unknown; destroy: ReturnType<typeof vi.fn> }>();
    Object.assign(scene, {
      chart, battle: new AuraBattle(chart), difficultyId: 'viral', noteObjects: notes,
      musicClock: clock, clockStartedAt: 100, paused: true, lifecycleActive: true, presentationReady: true,
      matchFinished: false, finalizing: false, layout: createAuraLayout(), scale: { width: 576, height: 1024 },
      applyLayout: vi.fn(), clockMs: vi.fn(() => { throw new Error('Resize must not sample the media clock'); }),
      createNote: (id: string) => {
        const marker = Object.assign(controlText(), { setAlpha() { return this; }, destroy: vi.fn() });
        notes.set(id, marker);
        return marker;
      },
    });
    scene.updateNotes(nowMs);
    const marker = notes.get(note.id)!;
    const oldX = marker.x;
    const scores = [scene.battle.scoreFor(0), scene.battle.scoreFor(1)];
    scene.onLayoutResize();
    const progress = 1 - (note.atMs - nowMs) / chart.noteTravelMs;
    expect(notes.get(note.id)).toBe(marker);
    expect(marker.x).toBe(scene.layout.highwayX + scene.layout.laneOffsets[note.lane]);
    expect(marker.x).not.toBe(oldX);
    expect(marker.y).toBeCloseTo(scene.layout.laneStartY + (scene.layout.laneTargetY - scene.layout.laneStartY) * progress, 10);
    expect(scene.musicClock).toBe(clock);
    expect(clock.timeMs).toBe(nowMs);
    expect(sampleClock).not.toHaveBeenCalled();
    expect(scene.clockMs).not.toHaveBeenCalled();
    expect(scene.soundManager.getBattleMusicClockSample).not.toHaveBeenCalled();
    expect([scene.battle.scoreFor(0), scene.battle.scoreFor(1)]).toEqual(scores);
    scene.fighters.forEach((fighter: Fighter) => expect(fighter.update).not.toHaveBeenCalled());
  });

  it.each([
    { clockStartedAt: null, matchFinished: false, finalizing: false },
    { clockStartedAt: 0, matchFinished: true, finalizing: false },
    { clockStartedAt: 0, matchFinished: false, finalizing: true },
  ])('does not recreate notes outside a live match on resize: %o', state => {
    const scene = Object.assign(new AuraScene(), harness().scene, state, {
      lifecycleActive: true, presentationReady: true, scale: { width: 576, height: 1024 },
      applyLayout: vi.fn(), updateNotes: vi.fn(),
    });
    scene.onLayoutResize();
    expect(scene.applyLayout).toHaveBeenCalledOnce();
    expect(scene.updateNotes).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3])('keeps lane %i aligned when its reduced-motion flash ends after a rotation', lane => {
    const scene = Object.assign(new AuraScene(), controlsHarness(), {
      lifecycleActive: true, presentationReady: true, clockStartedAt: null,
      scale: { width: 576, height: 1024 }, time: { delayedCall: vi.fn() },
    });
    scene.applyLayout = () => scene.drawLaneControlHints(0);
    scene.drawLaneControlHints(0);
    const oldX = scene.laneKeyTexts[lane].x;
    scene.flashLaneInput(0, lane);
    const [delay, finishFlash] = scene.time.delayedCall.mock.calls[0];
    expect(delay).toBe(120);
    scene.onLayoutResize();
    const expectedX = scene.layout.highwayX + scene.layout.laneOffsets[lane];
    expect(scene.laneKeyTexts[lane].x).toBe(expectedX);
    expect(expectedX).not.toBe(oldX);
    finishFlash();
    expect(scene.laneKeyTexts[lane]).toMatchObject({ x: expectedX, y: scene.layout.keyLabelY, scale: 1, color: '#fff4d6' });
    expect(scene.inputFlashGraphics[lane].setAlpha).toHaveBeenLastCalledWith(0);
    expect(scene.inputPulseGraphics[lane].setAlpha).toHaveBeenLastCalledWith(0);
  });

  it('cancels fallback uppercut physics translation at fixed rig scale without modifying the simulation or authored offsets', () => {
    const { scene } = harness(false);
    const fighter = scene.fighters[0] as Fighter;
    fighter.forceState(FighterState.UPPERCUT);
    fighter.y = 450;
    const reference = new Fighter(0, 'P1', fighter.x, true);
    reference.restore(fighter.snapshot());
    scene.performerContainers = [performerContainer().setScale(1.675), performerContainer().setScale(0.55)];
    const scaleCalls = scene.performerContainers.map((rig: ReturnType<typeof performerContainer>) => vi.spyOn(rig, 'setScale'));
    let reportedHeight = 200;
    scene.views.forEach((view: Record<string, unknown>, slot: number) => {
      view.getIdleBodyReference = () => ({ rootX: scene.fighters[slot].x + 3.5, rootY: scene.fighters[slot].y + 6, height: reportedHeight });
    });
    const beforeLift = fighter.snapshot();
    scene.advanceFighterPresentation(0);
    expect(fighter.snapshot()).toEqual(beforeLift);
    const beforeTranslation = scene.performerContainers[0].y;
    fighter.y -= 100;
    reference.y -= 100;
    reportedHeight = 150; // Even a changed measurement must not resize a running rig.
    scene.advanceFighterPresentation(0);
    expect(scene.performerContainers[0].y - beforeTranslation).toBeCloseTo(100 * 1.675, 10);
    for (const dt of [1 / 60, 1 / 60]) {
      reference.update(dt, EMPTY_INPUT, scene.fighters[1].x);
      scene.advanceFighterPresentation(dt);
      const body = scene.views[0].getIdleBodyReference();
      const rig = scene.performerContainers[0];
      const placement = auraPerformerPlacement(scene.layout, 0, scene.activePerformerSlot);
      expect(body.rootY * rig.scaleY + rig.y).toBeCloseTo(placement.footY, 10);
      expect(body.rootX * rig.scaleX + rig.x).toBeCloseTo(placement.x, 10);
      expect((body.rootY - 22) * rig.scaleY + rig.y).toBeCloseTo(placement.footY - 22 * 1.675, 10);
      expect(rig.scaleX).toBe(1.675);
      expect(rig.scaleY).toBe(1.675);
      expect(fighter.snapshot()).toEqual(reference.snapshot());
    }
    expect(fighter.update).toHaveBeenCalledTimes(2);
    expect(scene.fighters[1].update).not.toHaveBeenCalled();
    scaleCalls.forEach((setScale: ReturnType<typeof vi.spyOn>) => expect(setScale).not.toHaveBeenCalled());
  });

  it.each([
    { lifecycleActive: false, presentationReady: true },
    { lifecycleActive: true, presentationReady: false },
  ])('ignores resize before usable presentation or after shutdown: %o', state => {
    const scene = Object.assign(new AuraScene(), harness().scene, state, {
      scale: { width: 576, height: 1024 }, applyLayout: vi.fn(),
    });
    scene.onLayoutResize();
    expect(scene.applyLayout).not.toHaveBeenCalled();
    expect(scene.comicFeedback.beginTurn).not.toHaveBeenCalled();
  });

  it('inserts the floor marker behind both performer containers, preserving the backdrop first', () => {
    const { scene } = harness();
    const backdrop = {}, p1 = {}, p2 = {};
    const children: unknown[] = [backdrop, p1, p2];
    const glow = Object.fromEntries(['setDepth', 'setBlendMode', 'lineStyle', 'strokeEllipse']
      .map(name => [name, vi.fn().mockReturnThis()]));
    Object.assign(scene, {
      performerContainers: [p1, p2], add: { graphics: () => glow }, createPlayerTag: vi.fn(() => ({})),
      worldLayer: {
        getIndex: (child: unknown) => children.indexOf(child),
        addAt: (child: unknown, index: number) => children.splice(index, 0, child),
      },
    });
    scene.createWorldEffects();
    expect(children).toEqual([backdrop, glow, p1, p2]);
  });
});

describe('AuraScene visible presentation handshake', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function handshakeHarness() {
    if (typeof window === 'undefined') vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    return Object.assign(new AuraScene(), harness().scene, {
      lifecycleActive: true, presentationReady: true, presentationStarted: false,
      presentationToken: 41, matchSeed: 67, localOnlineReady: false, online: null,
      beginClock: vi.fn(), announceOnlineReady: vi.fn(), prepareStartup: vi.fn(),
      soundManager: { unlockPreparedMedia: vi.fn().mockResolvedValue(true) },
    });
  }

  function asyncCreateHarness(data: Partial<MatchSceneData> = {}) {
    vi.spyOn(SoundManager.prototype, 'prepareBattleMusic').mockResolvedValue(true);
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      location: { search: '' }, matchMedia: () => ({ matches: false }) });
    const scene = new AuraScene() as unknown as Record<string, any>;
    scene.init({ gameMode: 'aura', vsAI: true, seed: 67, ...data });
    let resolveLoad!: () => void;
    let rejectLoad!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
    Object.assign(scene, {
      lifecycleActive: true, lifecycleEpoch: 1, beginLifecycle: () => 1,
      scale: { width: 1024, height: 576, on: vi.fn() }, add: { container: vi.fn(() => ({})) },
      textures: { exists: vi.fn(() => true) },
      setMatchActionsVisible: vi.fn(), emitCapture: vi.fn(), emitPresentation: vi.fn(),
      loadFighters: () => pending, createStage: vi.fn(), loadCustomStage: vi.fn(), createFighters: vi.fn(), createWorldEffects: vi.fn(),
      createUi: vi.fn(), createCameras: vi.fn(), applyLayout: vi.fn(), createInput: vi.fn(),
      updateScoreUi: vi.fn(), updateTurnPresentation: vi.fn(), beginClock: vi.fn(), announceOnlineReady: vi.fn(),
      warmPresentation: vi.fn().mockResolvedValue(true),
    });
    return { scene, resolveLoad, rejectLoad };
  }

  it.each([
    { data: {}, expectedId: DEFAULT_AURA_STAGE_ID, expectedLabel: 'AURA PLAZA' },
    { data: { stageId: 'executive-rumble' as const }, expectedId: 'executive-rumble', expectedLabel: 'EXECUTIVE RUMBLE' },
    { data: { customStageKey: 'my-photo', customStageLabel: 'My photo' }, expectedId: DEFAULT_AURA_STAGE_ID, expectedLabel: 'MY PHOTO' },
  ])('creates the requested stage without overriding explicit or custom choices: $expectedLabel', async ({ data, expectedId, expectedLabel }) => {
    const { scene, resolveLoad } = asyncCreateHarness(data);
    const pendingCreate = scene.create();
    resolveLoad();
    await pendingCreate;
    expect(scene.resolvedStageId).toBe(expectedId);
    expect(scene.stageLabel).toBe(expectedLabel);
    expect(scene.createStage).toHaveBeenCalledExactlyOnceWith(`aura_stage_${expectedId}`);
    if ('customStageKey' in data) expect(scene.loadCustomStage).toHaveBeenCalledExactlyOnceWith(1);
    else expect(scene.loadCustomStage).not.toHaveBeenCalled();
  });

  it('uses the latest orientation after async assets finish and still waits for the visible acknowledgement', async () => {
    const { scene, resolveLoad } = asyncCreateHarness();
    const pendingCreate = scene.create();
    expect(scene.presentationReady).toBe(false);
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.emitPresentation).not.toHaveBeenCalledWith('ready');
    scene.scale.width = 576;
    scene.scale.height = 1024;
    resolveLoad();
    await pendingCreate;
    expect(scene.layout).toEqual(createAuraLayout(576, 1024));
    expect(scene.presentationReady).toBe(true);
    expect(scene.emitPresentation).toHaveBeenCalledExactlyOnceWith('ready');
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.announceOnlineReady).not.toHaveBeenCalled();
    expect(scene.videoRecorder).toBeNull();
  });

  it('reports asset failure without opening the loading curtain or starting capture', async () => {
    const { scene, rejectLoad } = asyncCreateHarness();
    const pendingCreate = scene.create();
    rejectLoad(new Error('Test asset unavailable'));
    await pendingCreate;
    expect(scene.emitPresentation).toHaveBeenCalledExactlyOnceWith('error');
    expect(scene.presentationReady).toBe(false);
    expect(scene.createFighters).not.toHaveBeenCalled();
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.videoRecorder).toBeNull();
  });

  it('keeps loading until audio, custom stage and rendered warmup are actually available', async () => {
    const { scene, resolveLoad } = asyncCreateHarness({ customStageKey: 'my-photo' });
    let audio!: (ready: boolean) => void;
    let stage!: () => void;
    let rendered!: (ready: boolean) => void;
    vi.mocked(SoundManager.prototype.prepareBattleMusic).mockImplementation(() => new Promise(resolve => { audio = resolve; }));
    scene.loadCustomStage.mockImplementation(() => new Promise<void>(resolve => { stage = resolve; }));
    scene.warmPresentation.mockImplementation(() => new Promise<boolean>(resolve => { rendered = resolve; }));
    const creation = scene.create();
    resolveLoad();
    await Promise.resolve();
    expect(scene.createStage).not.toHaveBeenCalled();
    audio(true);
    await Promise.resolve(); await Promise.resolve();
    expect(scene.createStage).toHaveBeenCalledOnce();
    expect(scene.presentationReady).toBe(false);
    stage();
    await Promise.resolve(); await Promise.resolve();
    expect(scene.warmPresentation).toHaveBeenCalledOnce();
    expect(scene.emitPresentation).not.toHaveBeenCalledWith('ready');
    rendered(true);
    await creation;
    expect(scene.emitPresentation).toHaveBeenCalledExactlyOnceWith('ready');
    expect(scene.clockStartedAt).toBeNull();
    expect(scene.videoRecorder).toBeNull();
  });

  it('keeps the curtain closed when a decoded performer lacks required Aura moves', async () => {
    const { scene } = asyncCreateHarness({ p1PhotoHash: 'player-photo', p2PhotoHash: 'rival-photo' });
    scene.loadFighters = (AuraScene.prototype as unknown as Record<string, any>).loadFighters;
    assetLoaders.combat.mockResolvedValue(true);
    assetLoaders.aura.mockResolvedValueOnce(loadedAuraPack()).mockResolvedValueOnce(null);
    await scene.create();
    expect(scene.emitPresentation).toHaveBeenCalledExactlyOnceWith('error');
    expect(scene.presentationReady).toBe(false);
    expect(scene.createFighters).not.toHaveBeenCalled();
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.announceOnlineReady).not.toHaveBeenCalled();
    expect(scene.videoRecorder).toBeNull();
    assetLoaders.aura.mockReset();
    assetLoaders.combat.mockReset();
  });

  it('ignores an old assets completion after its lifecycle has ended', async () => {
    const { scene, resolveLoad } = asyncCreateHarness();
    const pendingCreate = scene.create();
    scene.lifecycleActive = false;
    scene.lifecycleEpoch = 2;
    resolveLoad();
    await pendingCreate;
    expect(scene.emitPresentation).not.toHaveBeenCalled();
    expect(scene.createFighters).not.toHaveBeenCalled();
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.videoRecorder).toBeNull();
  });

  it.each([
    { detail: { token: 40, seed: 67 }, state: {}, label: 'stale token' },
    { detail: { token: 41, seed: 68 }, state: {}, label: 'different match seed' },
    { detail: null, state: {}, label: 'malformed event' },
    { detail: { token: 41, seed: 67 }, state: { lifecycleActive: false }, label: 'shut-down scene' },
    { detail: { token: 41, seed: 67 }, state: { presentationReady: false }, label: 'assets still loading' },
  ])('does not start gameplay for $label', ({ detail, state }) => {
    const scene = Object.assign(handshakeHarness(), state);
    scene.onPresentationStart({ detail });
    expect(scene.presentationStarted).toBe(false);
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.announceOnlineReady).not.toHaveBeenCalled();
    expect(scene.emitPresentationTurn).not.toHaveBeenCalled();
  });

  it('waits for a real Ready gesture after the curtain acknowledgement, then starts preparation once', async () => {
    const scene = handshakeHarness();
    scene.onPresentationStart({ detail: { token: 41, seed: 67 } });
    scene.onPresentationStart({ detail: { token: 41, seed: 67 } });
    expect(scene.presentationStarted).toBe(true);
    expect(scene.awaitingStartInput).toBe(true);
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.soundManager.unlockPreparedMedia).not.toHaveBeenCalled();
    scene.onStartupReady({ detail: { token: 40, seed: 67 } });
    scene.onStartupReady({ detail: { token: 41, seed: 67 } });
    scene.onStartupReady({ detail: { token: 41, seed: 67 } });
    expect(scene.soundManager.unlockPreparedMedia).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(scene.prepareStartup).toHaveBeenCalledOnce();
    expect(scene.announceOnlineReady).not.toHaveBeenCalled();
    expect(scene.emitPresentationTurn).not.toHaveBeenCalled();
  });

  it.each([0, 1])('does not advertise online readiness before the real Ready gesture and intro, for player %i', localSlot => {
    const scene = Object.assign(handshakeHarness(), { online: { localSlot, matchSerial: 3 } });
    scene.onPresentationStart({ detail: { token: 40, seed: 67 } });
    expect(scene.localOnlineReady).toBe(false);
    scene.onPresentationStart({ detail: { token: 41, seed: 67 } });
    scene.onPresentationStart({ detail: { token: 41, seed: 67 } });
    expect(scene.localOnlineReady).toBe(false);
    expect(scene.awaitingStartInput).toBe(true);
    expect(scene.announceOnlineReady).not.toHaveBeenCalled();
    expect(scene.beginClock).not.toHaveBeenCalled(); // The network start remains authoritative.
  });

  it.each([
    { lifecycleActive: false, presentationReady: true, presentationStarted: true },
    { lifecycleActive: true, presentationReady: false, presentationStarted: true },
    { lifecycleActive: true, presentationReady: true, presentationStarted: false },
  ])('cannot bypass presentation readiness through a direct/network clock request: %o', state => {
    const scene = Object.assign(handshakeHarness(), state, {
      scheduledClockStart: null, clockStartedAt: null,
      soundManager: { stopBattleMusic: vi.fn(), startBattleMusic: vi.fn(), startAuraCrowd: vi.fn() },
    });
    delete scene.beginClock;
    scene.beginClock(1600);
    expect(scene.scheduledClockStart).toBeNull();
    expect(scene.clockStartedAt).toBeNull();
    expect(scene.time.delayedCall).not.toHaveBeenCalled();
    expect(scene.soundManager.stopBattleMusic).not.toHaveBeenCalled();
    expect(scene.soundManager.startBattleMusic).not.toHaveBeenCalled();
    expect(scene.soundManager.startAuraCrowd).not.toHaveBeenCalled();
    expect(scene.videoRecorder).toBeNull();
  });

  it('schedules just one real clock start after the gates are open', () => {
    const scene = Object.assign(handshakeHarness(), {
      presentationStarted: true, scheduledClockStart: null, clockStartedAt: null,
      soundManager: { stopBattleMusic: vi.fn() },
    });
    delete scene.beginClock;
    vi.spyOn(performance, 'now').mockReturnValue(500);
    scene.beginClock(1600);
    scene.beginClock(1600);
    expect(scene.scheduledClockStart).toBe(2100);
    expect(scene.time.delayedCall).toHaveBeenCalledExactlyOnceWith(1600, expect.any(Function));
    expect(scene.soundManager.stopBattleMusic).toHaveBeenCalledOnce();
  });

  it('rejects an online start before local readiness without saving a stale deadline, then accepts a fresh host start', () => {
    const scene = Object.assign(handshakeHarness(), {
      presentationStarted: true, scheduledClockStart: null, clockStartedAt: null,
      online: { localSlot: 1, matchSerial: 3 },
      onlineSession: { seat: 'guest', transport: { getState: () => ({ rttMs: 100 }) } },
      soundManager: { stopBattleMusic: vi.fn(), startAuraCrowd: vi.fn() },
    });
    delete scene.beginClock;
    vi.spyOn(performance, 'now').mockReturnValue(500);
    scene.beginClock(3000);
    scene.onOnlineControl({ t: 'aura_start', matchSerial: 3, delayMs: 3000 });
    expect(scene.scheduledClockStart).toBeNull();
    expect(scene.clockStartedAt).toBeNull();
    expect(scene.time.delayedCall).not.toHaveBeenCalled();
    expect(scene.soundManager.stopBattleMusic).not.toHaveBeenCalled();

    scene.localOnlineReady = true;
    expect(scene.scheduledClockStart).toBeNull();
    scene.onOnlineControl({ t: 'aura_start', matchSerial: 3, delayMs: 3000 });
    scene.onOnlineControl({ t: 'aura_start', matchSerial: 3, delayMs: 3000 });
    expect(scene.scheduledClockStart).toBe(3450);
    expect(scene.time.delayedCall).toHaveBeenCalledExactlyOnceWith(2950, expect.any(Function));
    expect(scene.soundManager.stopBattleMusic).toHaveBeenCalledOnce();
  });

  it('reopens loading with a fresh token on a same-seed rematch and rejects the old acknowledgement', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent, location: { search: '' }, matchMedia: () => ({ matches: false }) });
    const scene = new AuraScene() as unknown as Record<string, any>;
    scene.init({ gameMode: 'aura', vsAI: true, seed: 67 });
    const first = scene.presentationToken;
    scene.presentationStarted = true;
    scene.presentationReady = true;
    scene.init({ gameMode: 'aura', vsAI: true, seed: 67 });
    expect(scene.presentationToken).toBeGreaterThan(first);
    expect(scene.presentationStarted).toBe(false);
    expect(scene.presentationReady).toBe(false);
    const loadingEvents = dispatchEvent.mock.calls.map(([event]) => event)
      .filter(event => event.type === AURA_PRESENTATION_EVENT);
    expect(loadingEvents.map(event => event.detail)).toEqual([
      { phase: 'loading', token: first, seed: 67, localControlledSlot: 0 },
      { phase: 'loading', token: scene.presentationToken, seed: 67, localControlledSlot: 0 },
    ]);
    Object.assign(scene, { lifecycleActive: true, presentationReady: true, beginClock: vi.fn() });
    scene.onPresentationStart({ detail: { token: first, seed: 67 } });
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it('labels the visible actor with the current match token without changing online input ownership', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const scene = Object.assign(handshakeHarness(), { online: { localSlot: 1, matchSerial: 3 } });
    delete scene.emitPresentationTurn;
    scene.focusPerformer(0);
    scene.focusPerformer(1);
    expect(dispatchEvent.mock.calls.map(([event]) => [event.type, event.detail])).toEqual([
      [AURA_PRESENTATION_TURN_EVENT, { token: 41, seed: 67, playerIndex: 0 }],
      [AURA_PRESENTATION_TURN_EVENT, { token: 41, seed: 67, playerIndex: 1 }],
    ]);
    expect(scene.online.localSlot).toBe(1);
  });
});

describe('AuraScene asynchronous challenge ownership', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('retries P2 at the exact music times, then remixes with the recipient identity still human', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent, location: { search: '' } });
    const routine = createAuraChallengeRoutine(987, 'viral', 'neon-arena', 'insert-player-arena')!;
    const challenge = createAuraChallenge(routine, 'Sender', 1_000, 1);
    const match = { ...buildAuraChallengeMatch(challenge), p2Name: 'Recipient', p2PhotoHash: 'own-photo',
      p2CloudFighterId: 'own-fighter', p2PersonalityId: 'showboat' as const };
    const scene = new AuraScene() as unknown as Record<string, any>;
    const restart = vi.fn(); scene.scene = { restart };
    scene.init(match);
    expect(scene.isCpuSlot(0)).toBe(true); expect(scene.isCpuSlot(1)).toBe(false);
    expect(scene.localControlledSlot()).toBe(1);
    scene.input = { keyboard: { addKey: () => ({ on: vi.fn() }), addCapture: vi.fn() } };
    scene.createInput(); scene.handleInput = vi.fn();
    scene.keyBindings[0].handler(); scene.keyBindings[3].handler();
    expect(scene.handleInput.mock.calls).toEqual([[1, 0], [1, 3]]);
    scene.performAction('run_it_back');
    const retry = restart.mock.calls[0][0];
    expect(retry).toMatchObject({ auraChallenge: challenge, seed: 987, auraTrackId: 'neon-arena', p2PhotoHash: 'own-photo' });
    scene.init(retry);
    expect(scene.localControlledSlot()).toBe(1);
    scene.performAction('remix');
    const remix = restart.mock.calls[1][0];
    expect(remix.auraChallenge).toBeUndefined(); expect(remix.seed).not.toBe(987);
    expect(remix).toMatchObject({ p1Name: 'Recipient', p1PhotoHash: 'own-photo', p1CloudFighterId: 'own-fighter', p1PersonalityId: 'showboat', p2Name: 'BYTE' });
    expect(remix.p2PhotoHash).toBeUndefined();
    scene.init(remix);
    expect(scene.isCpuSlot(0)).toBe(false); expect(scene.isCpuSlot(1)).toBe(true);
    expect(scene.localControlledSlot()).toBe(0);
    const slots = dispatchEvent.mock.calls.map(([event]) => event).filter(event => event.type === AURA_PRESENTATION_EVENT)
      .map(event => event.detail.localControlledSlot);
    expect(slots).toEqual([1, 1, 0]);
  });
});


describe('AuraScene first-play practice isolation', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function practiceHarness() {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const scene = Object.assign(new AuraScene(), harness().scene, {
      lifecycleActive: true, presentationReady: true, presentationStarted: true,
      presentationToken: 41, matchSeed: 67, isVsAI: true, cpuVsCpu: false, online: null,
      matchData: { gameMode: 'aura', vsAI: true },
      clockStartedAt: null, scheduledClockStart: null, paused: false, finalizing: false,
      onboarding: new AuraOnboarding(), onboardingGraphics: { ...controlGraphics(), destroy: vi.fn() },
      lastOnboardingState: null, phaseText: controlText(), turnText: controlText(), highwayTitleText: controlText(), highwayMetaText: controlText(),
      p1ScoreText: controlText(), p2ScoreText: controlText(), p2NameText: controlText(), duelMeterGraphics: controlGraphics(),
      comboText: controlText(), crowdLabelText: controlText(), crowdMeterGraphics: controlGraphics(), duelHeadingText: controlText(),
      flashLaneInput: vi.fn(), updateTurnPresentation: vi.fn(), beginClock: vi.fn(), prepareStartup: vi.fn(),
      recordJudgement: vi.fn(), applyJudgement: vi.fn(), updateNotes: vi.fn(), playCpuPlans: vi.fn(), collectHumanMisses: vi.fn(),
      advanceCameraPresentation: vi.fn(), advanceFighterPresentation: vi.fn(),
      soundManager: { updateAuraCrowd: vi.fn(), startBattleMusic: vi.fn(), startAuraCrowd: vi.fn(), unlockPreparedMedia: vi.fn().mockResolvedValue(true),
        pauseBattleMusic: vi.fn(), resumeBattleMusic: vi.fn() },
      actionRecorder: { record: vi.fn() }, videoRecorder: null,
      battle: new AuraBattle(createAuraChart(67, 'lowkey')),
    }) as unknown as Record<string, any>;
    return scene;
  }

  it('routes real lane inputs into unscored practice and starts the unchanged battle only after four correct hits', () => {
    const scene = practiceHarness();
    const chart = scene.battle.chart;
    const before = [scene.battle.scoreFor(0), scene.battle.scoreFor(1)];
    scene.handleInput(0, 0);
    expect(scene.onboarding.snapshot.cue).toBe('wait');
    expect(scene.beginClock).not.toHaveBeenCalled();
    for (const lane of [0, 1, 2, 3] as const) {
      scene.onboarding.advance(AURA_PRACTICE_TRAVEL_MS);
      scene.handleInput(1, lane); // CPU / another controller must not pass the lesson.
      expect(scene.onboarding.snapshot.completedLanes).toBe(lane);
      scene.handleInput(0, lane);
    }
    expect(scene.onboarding.snapshot.phase).toBe('complete');
    expect(scene.flashLaneInput).toHaveBeenCalledTimes(4);
    expect(scene.prepareStartup).toHaveBeenCalledOnce();
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.updateTurnPresentation).toHaveBeenCalledExactlyOnceWith(-1);
    expect(scene.battle.chart).toBe(chart);
    expect([scene.battle.scoreFor(0), scene.battle.scoreFor(1)]).toEqual(before);
    expect(scene.recordJudgement).not.toHaveBeenCalled();
    expect(scene.applyJudgement).not.toHaveBeenCalled();
    expect(scene.actionRecorder.record).not.toHaveBeenCalled();
    expect(scene.soundManager.startBattleMusic).not.toHaveBeenCalled(); // The existing beginClock owns audio/capture.
    expect(scene.videoRecorder).toBeNull();
  });

  it('blocks direct clock starts, scoring and CPU processing while practice is active', () => {
    const scene = practiceHarness();
    delete scene.beginClock;
    scene.beginClock(0);
    expect(scene.scheduledClockStart).toBeNull();
    scene.update(100, 100);
    expect(scene.onboarding.practiceProgress).toBeCloseTo(100 / AURA_PRACTICE_TRAVEL_MS);
    expect(scene.playCpuPlans).not.toHaveBeenCalled();
    expect(scene.collectHumanMisses).not.toHaveBeenCalled();
    expect(scene.updateNotes).not.toHaveBeenCalled();
    scene.paused = true;
    scene.update(200, 100);
    scene.handleInput(0, 0);
    expect(scene.onboarding.practiceProgress).toBeCloseTo(100 / AURA_PRACTICE_TRAVEL_MS);
  });

  it('ignores stale skip tokens, then skips practice exactly once', () => {
    const scene = practiceHarness();
    for (const detail of [{ token: 40, seed: 67 }, { token: 41, seed: 68 }, null]) scene.onOnboardingSkip({ detail });
    expect(scene.beginClock).not.toHaveBeenCalled();
    const event = { detail: { token: 41, seed: 67 } };
    scene.onOnboardingSkip(event);
    scene.onOnboardingSkip(event);
    expect(scene.onboarding.snapshot.phase).toBe('skipped');
    expect(scene.prepareStartup).toHaveBeenCalledOnce();
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.recordJudgement).not.toHaveBeenCalled();
  });

  it('keeps the practice checkpoint paused until resume and does not start audio through skip', () => {
    const scene = practiceHarness();
    scene.onboarding.advance(AURA_PRACTICE_TRAVEL_MS);
    scene.handleInput(0, 0);
    scene.onboarding.advance(400);
    const before = scene.onboarding.snapshot;
    scene.paused = true;
    scene.update(100, 100);
    scene.handleInput(0, 1);
    scene.onOnboardingSkip({ detail: { token: 41, seed: 67 } });
    expect(scene.onboarding.snapshot).toEqual(before);
    expect(scene.onboarding.practiceProgress).toBeCloseTo(400 / AURA_PRACTICE_TRAVEL_MS);
    expect(scene.beginClock).not.toHaveBeenCalled();
    scene.paused = false;
    scene.onOnboardingSkip({ detail: { token: 41, seed: 67 } });
    expect(scene.prepareStartup).toHaveBeenCalledOnce();
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it('resets tutorial state on init and ignores the previous scene token after a restart', () => {
    const scene = practiceHarness();
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), location: { search: '' },
      matchMedia: () => ({ matches: false }) });
    const oldToken = scene.presentationToken;
    scene.lastOnboardingState = 'previous practice';
    scene.init({ gameMode: 'aura', vsAI: true, seed: 67 });
    expect(scene.onboarding).toBeNull();
    expect(scene.onboardingGraphics).toBeNull();
    expect(scene.lastOnboardingState).toBeNull();
    expect(scene.presentationStarted).toBe(false);
    scene.onOnboardingSkip({ detail: { token: oldToken, seed: 67 } });
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it('dismisses remaining battle tips without restarting music, scores or recording', () => {
    const scene = practiceHarness();
    for (const lane of [0, 1, 2, 3] as const) {
      scene.onboarding.advance(AURA_PRACTICE_TRAVEL_MS);
      scene.onboarding.practiceInput(lane);
    }
    scene.clockStartedAt = 100;
    scene.onOnboardingSkip({ detail: { token: 41, seed: 67 } });
    expect(scene.onboarding.snapshot.phase).toBe('skipped');
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.updateTurnPresentation).not.toHaveBeenCalled();
  });

  it.each([{}, { onboarding: false }])('starts normal preparation without an explicit guide request: %o', async detail => {
    const scene = practiceHarness();
    scene.presentationStarted = false;
    scene.onboarding = null;
    scene.startOnboarding = vi.fn();
    scene.onPresentationStart({ detail: { token: 41, seed: 67, ...detail } });
    scene.onStartupReady({ detail: { token: 41, seed: 67 } });
    await Promise.resolve();
    expect(scene.startOnboarding).not.toHaveBeenCalled();
    expect(scene.prepareStartup).toHaveBeenCalledOnce();
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it('starts opted-in solo practice after the Ready gesture instead of the music clock', async () => {
    const scene = practiceHarness();
    scene.presentationStarted = false;
    scene.onboarding = null;
    scene.startOnboarding = vi.fn();
    scene.onPresentationStart({ detail: { token: 41, seed: 67, onboarding: true } });
    scene.onStartupReady({ detail: { token: 41, seed: 67 } });
    await Promise.resolve();
    expect(scene.startOnboarding).toHaveBeenCalledOnce();
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it.each([[false, true], [true, false]])('honors the explicit Ready choice practice=%s over the earlier onboarding=%s request', async (practice, onboarding) => {
    const scene = practiceHarness();
    scene.presentationStarted = false;
    scene.onboarding = null;
    scene.startOnboarding = vi.fn();
    scene.onPresentationStart({ detail: { token: 41, seed: 67, onboarding } });
    scene.onStartupReady({ detail: { token: 41, seed: 67, practice } });
    await Promise.resolve();
    expect(scene.startOnboarding).toHaveBeenCalledTimes(practice ? 1 : 0);
    expect(scene.prepareStartup).toHaveBeenCalledTimes(practice ? 0 : 1);
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it.each([{ cpuVsCpu: true }, { vsAI: false }, { auraChallenge: {} }, { online: { localSlot: 0 } }])(
    'ignores an onboarding request for protected match context %o', async data => {
      const scene = practiceHarness();
      scene.matchData = { gameMode: 'aura', vsAI: true, ...data };
      scene.presentationStarted = false;
      scene.onboarding = null;
      scene.startOnboarding = vi.fn();
      scene.onPresentationStart({ detail: { token: 41, seed: 67, onboarding: true } });
      scene.onStartupReady({ detail: { token: 41, seed: 67, practice: true } });
      await Promise.resolve();
      expect(scene.startOnboarding).not.toHaveBeenCalled();
      expect(scene.prepareStartup).toHaveBeenCalledOnce();
      expect(scene.beginClock).not.toHaveBeenCalled();
    },
  );

  it.each([[1024, 576], [576, 1024]])('keeps the held practice note at the real receptor through resize to %ix%i', (width, height) => {
    const scene = practiceHarness();
    scene.onboarding.advance(AURA_PRACTICE_TRAVEL_MS);
    scene.scale = { width, height };
    scene.applyLayout = vi.fn();
    const before = scene.onboarding.snapshot;
    scene.onLayoutResize();
    expect(scene.onboarding.snapshot).toEqual(before);
    expect(scene.onboarding.practiceProgress).toBe(1);
    expect(scene.phaseText.text).toBe('PRACTICE 1/4');
    expect(scene.turnText.text).toBe('NO SCORE YET');
    expect(scene.highwayTitleText.visible).toBe(false);
    expect(scene.highwayMetaText.visible).toBe(false);
    const highlight = scene.onboardingGraphics.fillRect.mock.calls[0];
    expect(highlight[0]).toBe(scene.layout.highwayX + scene.layout.laneOffsets[0] - 30);
    expect(highlight[1] + highlight[3]).toBe(scene.layout.laneTargetY);
    expect(scene.beginClock).not.toHaveBeenCalled();
    expect(scene.updateNotes).not.toHaveBeenCalled();
  });

  it('emits usable hints once per semantic change, with actual controls and lifecycle', () => {
    const scene = practiceHarness();
    scene.emitOnboarding();
    scene.onboarding.advance(10);
    scene.emitOnboarding();
    const events = vi.mocked(window.dispatchEvent).mock.calls.map(([event]) => event as CustomEvent);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(AURA_ONBOARDING_EVENT);
    expect(events[0].detail).toMatchObject({ token: 41, seed: 67, phase: 'practice', practiceLane: 0,
      completedLanes: 0, laneKeys: ['D', 'F', 'J', 'K'] });
    scene.onboarding.advance(AURA_PRACTICE_TRAVEL_MS);
    scene.emitOnboarding();
    expect(window.dispatchEvent).toHaveBeenCalledTimes(2);
  });
});

describe('AuraScene render, encoder and visible countdown gates', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function startupHarness() {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const scene = Object.assign(new AuraScene(), harness().scene, {
      lifecycleActive: true, lifecycleEpoch: 1, presentationReady: true, presentationStarted: true,
      presentationToken: 41, matchSeed: 67, online: null, cpuVsCpu: false,
      startup: null, startupView: { render: vi.fn() }, startupAbort: new AbortController(),
      turnText: controlText(), countInText: controlText(), lastCountIn: -1,
      chart: createAuraChart(67, 'lowkey'), track: DEFAULT_AURA_TRACK,
      clockStartedAt: null, scheduledClockStart: null, paused: false, captureId: 'intro',
      emitCapture: vi.fn(), emitPresentation: vi.fn(),
      waitForPresentationFrames: vi.fn().mockResolvedValue(true),
      advanceCameraPresentation: vi.fn(), advanceFighterPresentation: vi.fn(),
      updateTurn: vi.fn(), playCpuPlans: vi.fn(), collectHumanMisses: vi.fn(), updateNotes: vi.fn(), updateBeatPresentation: vi.fn(),
      soundManager: { getRecordingAudioTracks: vi.fn(() => []), unlockPreparedMedia: vi.fn().mockResolvedValue(true),
        updateAuraCrowd: vi.fn(), pauseBattleMusic: vi.fn(), resumeBattleMusic: vi.fn(),
        startBattleMusic: vi.fn(), stopBattleMusic: vi.fn(), startAuraCrowd: vi.fn(), playAuraCountIn: vi.fn(),
        getBattleMusicClockSample: vi.fn(() => ({ status: 'playing', positionMs: 0, durationMs: null, loop: false })) },
      actionRecorder: { record: vi.fn() },
    }) as unknown as Record<string, any>;
    vi.spyOn(scene, 'beginClock');
    return scene;
  }

  function advanceSong(scene: Record<string, any>, positionMs: number) {
    scene.soundManager.getBattleMusicClockSample.mockReturnValue({ status: 'playing', positionMs, durationMs: null, loop: false });
    scene.updateStartup(16);
  }

  it('captures a rendered intro before starting the song once, then follows one audible count-in through the first actual hit', async () => {
    const scene = startupHarness();
    let rendered!: (ready: boolean) => void;
    let encoded!: (ready: boolean) => void;
    scene.waitForPresentationFrames.mockImplementation(() => new Promise(resolve => { rendered = resolve; }));
    const start = vi.spyOn(AuraVideoRecorder.prototype, 'start').mockReturnValue({ ok: true });
    vi.spyOn(AuraVideoRecorder.prototype, 'whenStarted').mockImplementation(() => new Promise(resolve => { encoded = resolve; }));
    scene.game = { canvas: {} };
    const prepared = scene.prepareStartup();
    expect(start).not.toHaveBeenCalled();
    expect(scene.startup.snapshot.phase).toBe('preparing');
    rendered(true);
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
    expect(scene.emitCapture).not.toHaveBeenCalled();
    scene.update(0, 10_000);
    expect(scene.beginClock).not.toHaveBeenCalled();
    encoded(true);
    await prepared;
    expect(scene.emitCapture).toHaveBeenCalledWith({ id: 'intro', state: 'recording' });
    expect(scene.beginClock).toHaveBeenCalledExactlyOnceWith(0, true);
    expect(scene.soundManager.startBattleMusic).toHaveBeenCalledExactlyOnceWith(DEFAULT_AURA_TRACK.url);
    expect(scene.clockMs()).toBe(0);
    expect(scene.emitCapture.mock.invocationCallOrder[0]).toBeLessThan(scene.soundManager.startBattleMusic.mock.invocationCallOrder[0]);
    const turn = scene.chart.turns[0];
    const frozen = scene.startup.snapshot;
    scene.soundManager.getBattleMusicClockSample.mockReturnValue({ status: 'waiting' });
    scene.update(0, 60_000);
    expect(scene.startup.snapshot).toEqual(frozen); // Renderer/wall time cannot skip blocked audio.
    for (const count of [3, 2, 1]) {
      advanceSong(scene, turn.firstNoteMs - scene.chart.beatMs * count + 0.01);
      scene.updateCountIn(turn, scene.clockMs());
      expect(scene.startup.snapshot).toMatchObject({ phase: 'countdown', count });
      expect(scene.countInText.visible).toBe(false); // No second 4–3–2–1 over the lanes.
    }
    advanceSong(scene, turn.firstNoteMs);
    expect(scene.startup.snapshot.phase).toBe('playing');
    expect(scene.clockMs()).toBe(turn.firstNoteMs);
    expect(scene.soundManager.playAuraCountIn.mock.calls).toEqual([[3], [2], [1], ['go']]);
    expect(scene.soundManager.startBattleMusic).toHaveBeenCalledOnce();
    expect(scene.actionRecorder.record).not.toHaveBeenCalled();
    const states = vi.mocked(window.dispatchEvent).mock.calls.map(([event]) => event as CustomEvent)
      .filter(event => event.type === AURA_STARTUP_EVENT).map(event => event.detail);
    expect(states.map(state => [state.phase, state.count])).toEqual([
      ['preparing', null], ['versus', null], ['countdown', 3], ['countdown', 2], ['countdown', 1], ['playing', null],
    ]);
  });

  it.each([false, true])('keeps gameplay available after encoder failure, including unattended=%s autoplay rejection', async cpuVsCpu => {
    const scene = startupHarness();
    let wallMs = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wallMs);
    scene.cpuVsCpu = cpuVsCpu;
    scene.soundManager.unlockPreparedMedia.mockResolvedValue(false);
    scene.game = { canvas: {} };
    vi.spyOn(AuraVideoRecorder.prototype, 'start').mockReturnValue({ ok: false, reason: 'recording-unsupported' });
    await scene.prepareStartup();
    expect(scene.emitCapture).toHaveBeenCalledWith({ id: 'intro', state: 'unavailable', reason: 'recording-unsupported' });
    expect(scene.startup.snapshot.phase).toBe('versus');
    expect(scene.silentStartup).toBe(cpuVsCpu);
    expect(scene.beginClock).toHaveBeenCalledExactlyOnceWith(0, true);
    if (cpuVsCpu) {
      wallMs += scene.chart.turns[0].firstNoteMs;
      scene.updateStartup(16);
      expect(scene.soundManager.startBattleMusic).not.toHaveBeenCalled();
    } else advanceSong(scene, scene.chart.turns[0].firstNoteMs);
    expect(scene.startup.snapshot.phase).toBe('playing');
  });

  it('defers song zero when encoding finishes during pause, then resumes capture before starting music', async () => {
    const scene = startupHarness();
    let encoded!: (ready: boolean) => void;
    vi.spyOn(AuraVideoRecorder.prototype, 'start').mockReturnValue({ ok: true });
    vi.spyOn(AuraVideoRecorder.prototype, 'whenStarted').mockImplementation(() => new Promise(resolve => { encoded = resolve; }));
    const paused = vi.spyOn(AuraVideoRecorder.prototype, 'pause');
    const resumed = vi.spyOn(AuraVideoRecorder.prototype, 'resume');
    scene.game = { canvas: {} };
    const prepared = scene.prepareStartup();
    await Promise.resolve();
    scene.onPause({ detail: { paused: true } });
    expect(paused).toHaveBeenCalledOnce();
    encoded(true);
    await prepared;
    expect(scene.startup.snapshot.phase).toBe('versus');
    expect(scene.clockStartedAt).toBeNull();
    expect(scene.scheduledClockStart).toBeNull();
    expect(scene.soundManager.startBattleMusic).not.toHaveBeenCalled();
    scene.update(0, 30_000);
    expect(scene.clockStartedAt).toBeNull();
    scene.onPause({ detail: { paused: false } });
    expect(resumed).toHaveBeenCalledOnce();
    expect(resumed.mock.invocationCallOrder[0]).toBeLessThan(scene.soundManager.startBattleMusic.mock.invocationCallOrder[0]);
    expect(scene.clockMs()).toBe(0);
    expect(scene.soundManager.startBattleMusic).toHaveBeenCalledOnce();
    scene.onPause({ detail: { paused: false } });
    expect(scene.soundManager.startBattleMusic).toHaveBeenCalledOnce();
  });

  it('preserves the musical countdown position through pause without restarting the selected song', async () => {
    const scene = startupHarness();
    scene.game = { canvas: {} };
    vi.spyOn(AuraVideoRecorder.prototype, 'start').mockReturnValue({ ok: false, reason: 'recording-unsupported' });
    await scene.prepareStartup();
    const position = scene.chart.turns[0].firstNoteMs - scene.chart.beatMs * 2 + 0.01;
    advanceSong(scene, position);
    const frozen = scene.startup.snapshot;
    scene.onPause({ detail: { paused: true } });
    scene.update(0, 30_000);
    expect(scene.startup.snapshot).toEqual(frozen);
    expect(scene.clockMs()).toBe(position);
    scene.onPause({ detail: { paused: false } });
    expect(scene.soundManager.resumeBattleMusic).toHaveBeenCalledOnce();
    expect(scene.soundManager.startBattleMusic).toHaveBeenCalledOnce();
    advanceSong(scene, position);
    expect(scene.startup.snapshot).toEqual(frozen);
    expect(scene.soundManager.playAuraCountIn.mock.calls).toEqual([[2]]);
  });

  it.each([false, true])('ignores intro input and permits the first early note only during offline musical count-in (online=%s)', online => {
    const scene = startupHarness();
    scene.online = online ? { localSlot: 0, matchSerial: 1 } : null;
    scene.isVsAI = true;
    scene.battle = new AuraBattle(scene.chart);
    scene.flashLaneInput = vi.fn();
    scene.recordJudgement = vi.fn();
    scene.applyJudgement = vi.fn();
    const judge = vi.spyOn(scene.battle, 'judgeInput');
    const note = scene.chart.turns[0].notes[0];
    scene.startup = new AuraStartup(online, online ? undefined
      : { firstNoteMs: note.atMs, beatMs: scene.chart.beatMs });
    scene.startup.begin();
    scene.handleInput(0, note.lane, note.atMs - 20);
    expect(judge).not.toHaveBeenCalled();
    if (online) scene.startup.countdown(500);
    else scene.startup.syncMusic(note.atMs - 20);
    scene.handleInput(0, note.lane, note.atMs - 20);
    expect(judge).toHaveBeenCalledTimes(online ? 0 : 1);
    if (!online) {
      expect(scene.applyJudgement).toHaveBeenCalledWith(expect.objectContaining({ grade: 'perfect', noteId: note.id }), true, note.atMs - 20);
      expect(scene.battle.isJudged(note.id)).toBe(true);
    }
    expect(scene.recordJudgement).not.toHaveBeenCalled();
  });

  it('replaces the completed practice status throughout the captured intro and countdown without claiming play has begun', async () => {
    const scene = startupHarness();
    scene.onboarding = new AuraOnboarding();
    for (const lane of [0, 1, 2, 3] as const) {
      scene.onboarding.advance(AURA_PRACTICE_TRAVEL_MS);
      scene.onboarding.practiceInput(lane);
    }
    scene.turnText.setText('PRACTICE · 4/4 · NO SCORE YET');
    scene.game = { canvas: {} };
    vi.spyOn(AuraVideoRecorder.prototype, 'start').mockReturnValue({ ok: false, reason: 'recording-unsupported' });
    await scene.prepareStartup();
    expect(scene.turnText.text).toBe('AURA DUEL · GET READY');
    advanceSong(scene, scene.chart.turns[0].firstNoteMs - scene.chart.beatMs + 0.01);
    expect(scene.startup.snapshot).toMatchObject({ phase: 'countdown', count: 1 });
    expect(scene.turnText.text).toBe('AURA DUEL · GET READY');
    expect(scene.clockStartedAt).not.toBeNull();
    expect(scene.beginClock).toHaveBeenCalledExactlyOnceWith(0, true);
    expect(scene.actionRecorder.record).not.toHaveBeenCalled();
  });

  it('ignores a render completion from an abandoned lifecycle without opening capture', async () => {
    const scene = startupHarness();
    let rendered!: (ready: boolean) => void;
    scene.waitForPresentationFrames.mockImplementation(() => new Promise(resolve => { rendered = resolve; }));
    const start = vi.spyOn(AuraVideoRecorder.prototype, 'start');
    const prepared = scene.prepareStartup();
    scene.lifecycleActive = false;
    scene.lifecycleEpoch += 1;
    rendered(true);
    await prepared;
    expect(start).not.toHaveBeenCalled();
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it('returns to Ready after rejected audio, ignores paused input, and cannot start music by resuming preparation', async () => {
    const scene = startupHarness();
    scene.awaitingStartInput = true;
    scene.soundManager.unlockPreparedMedia.mockResolvedValue(false);
    scene.paused = true;
    scene.onStartupReady({ detail: { token: 41, seed: 67 } });
    expect(scene.soundManager.unlockPreparedMedia).not.toHaveBeenCalled();
    scene.onPause({ detail: { paused: false } });
    expect(scene.soundManager.resumeBattleMusic).not.toHaveBeenCalled();
    scene.onStartupReady({ detail: { token: 41, seed: 67 } });
    await Promise.resolve();
    expect(scene.awaitingStartInput).toBe(true);
    expect(scene.emitPresentation).not.toHaveBeenCalledWith('error');
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it('announces online readiness after local intro and retains the single network countdown', async () => {
    const scene = startupHarness();
    scene.online = { localSlot: 0, matchSerial: 1 };
    scene.game = { canvas: {} };
    scene.announceOnlineReady = vi.fn();
    vi.spyOn(AuraVideoRecorder.prototype, 'start').mockReturnValue({ ok: false, reason: 'recording-unsupported' });
    await scene.prepareStartup();
    expect(scene.announceOnlineReady).not.toHaveBeenCalled();
    for (let frame = 0; frame < 15; frame += 1) scene.updateStartup(100);
    expect(scene.announceOnlineReady).toHaveBeenCalledOnce();
    expect(scene.beginClock).not.toHaveBeenCalled();
    scene.scheduledClockStart = performance.now() + 1_000;
    scene.updateStartup(100);
    expect(scene.startup.snapshot.phase).toBe('countdown');
    expect(scene.startup.snapshot.remainingMs).toBeLessThanOrEqual(1_000);
    expect(scene.beginClock).not.toHaveBeenCalled();
  });

  it('enables online count-in audio after stopping preparation and emits GO only after the song starts', () => {
    const scene = startupHarness();
    scene.online = { localSlot: 0, matchSerial: 1 };
    scene.localOnlineReady = true;
    scene.startup = new AuraStartup(true);
    scene.startup.begin();
    scene.beginClock(3_000);
    const sounds = scene.soundManager;
    expect(sounds.stopBattleMusic.mock.invocationCallOrder[0]).toBeLessThan(sounds.startAuraCrowd.mock.invocationCallOrder[0]);
    expect(sounds.startAuraCrowd.mock.invocationCallOrder[0]).toBeLessThan(sounds.playAuraCountIn.mock.invocationCallOrder[0]);
    expect(sounds.playAuraCountIn.mock.calls).toEqual([[3]]);
    expect(sounds.startBattleMusic).not.toHaveBeenCalled();
    scene.time.delayedCall.mock.calls[0][1]();
    expect(sounds.startBattleMusic).toHaveBeenCalledOnce();
    expect(sounds.playAuraCountIn.mock.calls).toEqual([[3], ['go']]);
    expect(sounds.startBattleMusic.mock.invocationCallOrder[0]).toBeLessThan(sounds.playAuraCountIn.mock.invocationCallOrder[1]);
    expect(scene.startup.snapshot.phase).toBe('playing');
  });
});
