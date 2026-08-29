import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANIMATIONS,
  PROVIDER_MATRIX_PAID_APPROVALS,
  PROVIDER_MATRIX_STAGE1_HARD_CAP_USD,
  RENDERERS,
  STRATEGIES,
  buildProviderPrompt,
  buildStrategyPlan,
  directSheetLayout,
  orderedReferences,
  validateStrategyPlan,
} from './catalog.ts';

test('catalog freezes seven renderers, six strategies, and eleven animation topologies', () => {
  assert.equal(RENDERERS.length, 7);
  assert.equal(Object.keys(STRATEGIES).length, 6);
  assert.equal(Object.keys(ANIMATIONS).length, 11);
});

test('attack topologies pay only four unique poses and mirror locally', () => {
  for (const id of ['high_punch', 'high_kick', 'low_punch', 'low_kick'] as const) {
    assert.equal(ANIMATIONS[id].uniqueFrameCount, 4);
    assert.deepEqual(ANIMATIONS[id].playbackOrder, [0, 1, 2, 3, 2, 1, 0]);
  }
});

test('direct sheets use animation-specific grids while staying at or below four megapixels', () => {
  assert.deepEqual(directSheetLayout(ANIMATIONS.high_kick), { columns: 2, rows: 2, width: 1728, height: 2304 });
  assert.deepEqual(directSheetLayout(ANIMATIONS.idle), { columns: 4, rows: 2, width: 2432, height: 1632 });
  assert.deepEqual(directSheetLayout(ANIMATIONS.walk), { columns: 4, rows: 4, width: 1728, height: 2304 });
  for (const topology of Object.values(ANIMATIONS)) {
    const layout = directSheetLayout(topology);
    assert.ok(layout.width * layout.height <= 4_000_000);
  }
  assert.match(buildProviderPrompt('klein-9b', 'direct-sheet', 'high_kick'), /2 by 2 sprite sheet/);
});

test('fal adapters put the editable image first and Gemini preserves semantic order', () => {
  assert.deepEqual(
    orderedReferences('klein-9b', 'sheet-independent', 2).map((reference) => reference.role),
    ['pose-cell', 'canonical'],
  );
  assert.deepEqual(
    orderedReferences('gemini-pro', 'sheet-independent', 2).map((reference) => reference.role),
    ['canonical', 'pose-cell'],
  );
  assert.deepEqual(
    orderedReferences('klein-9b', 'canonical-previous', 2).map((reference) => reference.role),
    ['previous-frame', 'canonical'],
  );
});

test('previous-delta is a strict one-reference chain from the frozen F0', () => {
  const plan = buildStrategyPlan('klein-9b', 'previous-delta', 'high_kick');
  validateStrategyPlan(plan);
  const generations = plan.nodes.filter((node) => node.kind === 'generate-frame');
  const cleanups = plan.nodes.filter((node) => node.kind === 'cleanup');
  assert.equal(generations.length, 3);
  assert.equal(cleanups.length, 3);
  assert.equal(plan.guardedBudgetUsd, 0.069);
  assert.ok(plan.guardedBudgetUsd <= PROVIDER_MATRIX_STAGE1_HARD_CAP_USD);
  assert.deepEqual(generations.map((node) => node.kind === 'generate-frame'
    ? node.references.map((reference) => reference.role)
    : []), [['previous-frame'], ['previous-frame'], ['previous-frame']]);
  assert.match(generations[0]?.kind === 'generate-frame' ? generations[0].prompt : '', /viewer-left side planted/);
  assert.doesNotMatch(generations[0]?.kind === 'generate-frame' ? generations[0].prompt : '', /pose target/i);
});

test('per-frame prompts explain the complete motion and exact place in the sequence', () => {
  const frame2 = buildProviderPrompt('klein-9b', 'previous-delta', 'high_kick', 2);
  assert.match(frame2, /ANIMATION TRAJECTORY — context only/);
  assert.match(frame2, /ordered motion with 4 unique key poses, F0 through F3/);
  assert.match(frame2, /Full ordered motion, for context only: F0 = neutral standing guard/);
  assert.match(frame2, /Final playback order: F0 -> F1 -> F2 -> F3 -> F2 -> F1 -> F0/);
  assert.match(frame2, /generate only F2, the 3rd unique key pose out of 4/);
  assert.match(frame2, /PREVIOUS INPUT PHASE F1: compact chamber/);
  assert.match(frame2, /CURRENT TARGET F2: advanced high chamber/);
  assert.match(frame2, /NEXT PHASE F3 — trajectory context only, do not render it yet/);
  assert.match(frame2, /clear, substantial progression/);
  assert.match(frame2, /do not return an unchanged or near-identical chamber/);
  assert.match(frame2, /Preserve identity, outfit, texture, camera, scale and background, but not the previous pose/);
  assert.match(frame2, /Do not copy or return F1/);
  assert.doesNotMatch(frame2, /slightly farther/);

  const frame3 = buildProviderPrompt('klein-9b', 'previous-delta', 'high_kick', 3);
  assert.match(frame3, /generate only F3, the 4th unique key pose out of 4/);
  assert.match(frame3, /F3 is the terminal generated apex/);
  assert.match(frame3, /Playback later reverses locally to the already generated F2/);

  const walkFinal = buildProviderPrompt('klein-9b', 'previous-delta', 'walk', 15);
  assert.match(walkFinal, /NEXT PLAYBACK PHASE is F0 for loop closure/);
  const koFinal = buildProviderPrompt('klein-9b', 'previous-delta', 'ko', 7);
  assert.match(koFinal, /There is no next generated phase/);
});

test('trajectory context is isolated to chained strategies', () => {
  for (const strategy of ['previous-delta', 'canonical-previous', 'previous-pose'] as const) {
    assert.match(buildProviderPrompt('klein-9b', strategy, 'high_kick', 2), /ANIMATION TRAJECTORY/);
  }
  for (const strategy of ['sheet-independent', 'canonical-independent'] as const) {
    assert.doesNotMatch(buildProviderPrompt('klein-9b', strategy, 'high_kick', 2), /ANIMATION TRAJECTORY/);
  }
});

test('provider prompts name the actual payload order', () => {
  const falPrompt = buildProviderPrompt('klein-9b', 'sheet-independent', 'high_kick', 2);
  assert.match(falPrompt, /IMAGE 1 is a pose target only/);
  assert.match(falPrompt, /IMAGE 2 is the immutable identity/);
  const geminiPrompt = buildProviderPrompt('gemini-pro', 'sheet-independent', 'high_kick', 2);
  assert.match(geminiPrompt, /IMAGE 1 is the immutable identity/);
  assert.match(geminiPrompt, /IMAGE 2 is a pose target only/);
});

test('every renderer and strategy compiles for every animation', () => {
  for (const renderer of RENDERERS) {
    for (const strategyId of Object.keys(STRATEGIES) as Array<keyof typeof STRATEGIES>) {
      for (const animationId of Object.keys(ANIMATIONS) as Array<keyof typeof ANIMATIONS>) {
        const plan = buildStrategyPlan(renderer.id, strategyId, animationId);
        validateStrategyPlan(plan);
        assert.ok(plan.maxPaidSubmissions > 0);
      }
    }
  }
});

test('the full HIGH_KICK cartesian matrix is visible but deliberately too large for one batch', () => {
  let guardedBudgetUsd = 0;
  let maxPaidSubmissions = 0;
  for (const renderer of RENDERERS) {
    for (const strategyId of Object.keys(STRATEGIES) as Array<keyof typeof STRATEGIES>) {
      const plan = buildStrategyPlan(renderer.id, strategyId, 'high_kick');
      guardedBudgetUsd += plan.guardedBudgetUsd;
      maxPaidSubmissions += plan.maxPaidSubmissions;
    }
  }
  assert.equal(Number(guardedBudgetUsd.toFixed(6)), 6.748);
  assert.equal(maxPaidSubmissions, 217);
});

test('no paid matrix gate remains active after the F2 stop', () => {
  assert.equal(PROVIDER_MATRIX_PAID_APPROVALS.filter((approval) => approval.status === 'approved').length, 0);
  assert.equal(PROVIDER_MATRIX_PAID_APPROVALS[0]?.status, 'closed');
  assert.equal(PROVIDER_MATRIX_PAID_APPROVALS[0]?.maxThroughFrame, 2);
});
