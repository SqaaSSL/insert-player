import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRUMP_PROD_FLOW_HARD_CAP_USD,
  TRUMP_PROD_FLOW_MAX_SUBMISSIONS,
  TRUMP_RENDERERS,
  benchmarkFingerprint,
  buildTrumpHighKickScaffoldPrompt,
  buildTrumpRefinePrompt,
  buildTrumpSourcePrompt,
  guardedBudgetUsd,
  validateTrumpProdFlowPlan,
} from './trumpProdFlowBenchmark.ts';

test('freezes the six isolated renderers and the approved cap', () => {
  validateTrumpProdFlowPlan();
  assert.deepEqual(TRUMP_RENDERERS.map((renderer) => renderer.id), [
    'gemini-flash',
    'klein-4b',
    'klein-9b',
    'flux2-pro',
    'flux2-flash',
    'seedream-4',
  ]);
  assert.equal(TRUMP_PROD_FLOW_MAX_SUBMISSIONS, 60);
  assert.equal(guardedBudgetUsd(), 2.014);
  assert.ok(guardedBudgetUsd() <= TRUMP_PROD_FLOW_HARD_CAP_USD);
  assert.equal(
    benchmarkFingerprint(),
    '4af0d4e8244569f6cf05cb8bcb9529755ecd9715e2a49b49fc5865857211d430',
  );
});

test('keeps the original portrait in source and every refine contract', () => {
  const source = buildTrumpSourcePrompt();
  assert.match(source, /IMAGE 1 as the exact identity and surface-appearance reference/);
  assert.match(source, /exactly two arms ending in two hands/);

  for (const renderer of TRUMP_RENDERERS) {
    for (let frameIndex = 0; frameIndex < 4; frameIndex += 1) {
      const prompt = buildTrumpRefinePrompt(renderer.id, frameIndex);
      assert.match(prompt, /IMAGE 2/, `${renderer.id} F${frameIndex} must declare the original/reference role`);
      assert.match(prompt, /exactly two arms ending in exactly two hands/);
      assert.match(prompt, /exactly two legs ending in exactly two feet/);
    }
  }
});

test('keeps HIGH_KICK frame semantics distinct', () => {
  const scaffold = buildTrumpHighKickScaffoldPrompt();
  assert.match(scaffold, /CELL 1: neutral ready guard before the attack/);
  assert.match(scaffold, /CELL 2: initial compact knee chamber/);
  assert.match(scaffold, /CELL 3: advanced higher chamber/);
  assert.match(scaffold, /CELL 4: fully extended high side-kick impact/);

  assert.match(buildTrumpRefinePrompt('klein-9b', 0), /neutral guard before the attack, not a kick/);
  assert.match(buildTrumpRefinePrompt('klein-9b', 1), /initial chamber, not impact/);
  assert.match(buildTrumpRefinePrompt('klein-9b', 2), /advanced high chamber, not impact/);
  assert.match(buildTrumpRefinePrompt('klein-9b', 3), /fully extended high-kick impact/);
});

