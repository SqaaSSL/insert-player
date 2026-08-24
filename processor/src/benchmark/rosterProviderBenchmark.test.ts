import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BENCHMARK_HARD_CAP_USD,
  buildBenchmarkRequests,
  buildBudgetSummary,
  buildHighKickRefinePrompt,
  buildWalkPrompt,
  sha256Text,
  validateBenchmarkPlan,
} from './rosterProviderBenchmark.ts';

test('freezes the exact current WALK and HIGH_KICK refine prompts', () => {
  assert.equal(buildWalkPrompt().length, 2965);
  assert.equal(sha256Text(buildWalkPrompt()), '5bef4fa7e3d13b0a4e13fd8cc355fcf135210c3e86ec11f51f73691a299cda19');
  assert.equal(buildHighKickRefinePrompt().length, 2105);
  assert.equal(sha256Text(buildHighKickRefinePrompt()), 'a030e3908944b9bf9ac71030ca4c39e392f54a1b7b3a6a62110e9688e1b01b96');
});

test('keeps the approved call count and guarded budget', () => {
  const requests = buildBenchmarkRequests();
  const budget = buildBudgetSummary(requests);
  validateBenchmarkPlan(requests);

  assert.equal(requests.length, 7);
  assert.equal(requests.filter((request) => request.plan === 'A').length, 1);
  assert.equal(requests.filter((request) => request.plan === 'B').length, 6);
  assert.equal(budget.combinedFixedUsd, 0.383);
  assert.equal(budget.combinedGuardedUsd, 0.441);
  assert.equal(budget.hardCapUsd, BENCHMARK_HARD_CAP_USD);
  assert.ok(budget.combinedGuardedUsd <= BENCHMARK_HARD_CAP_USD);
});

test('uses a true 4K 3:4 WALK sheet and a common two-reference Plan B contract', () => {
  const requests = buildBenchmarkRequests();
  const planA = requests.find((request) => request.plan === 'A');
  const planB = requests.filter((request) => request.plan === 'B');
  assert.ok(planA);
  assert.deepEqual(planA.references, ['identity']);
  assert.equal(planA.output.requestedWidth, 3584);
  assert.equal(planA.output.requestedHeight, 4800);
  const generationConfig = (planA.payloadTemplate.generationConfig ?? {}) as Record<string, unknown>;
  assert.deepEqual(generationConfig.imageConfig, { aspectRatio: '3:4', imageSize: '4K' });
  assert.equal(generationConfig.responseFormat, undefined);

  for (const request of planB) {
    assert.deepEqual(request.references, ['identity', 'high-kick-impact']);
    assert.equal(request.promptSha256, planB[0]?.promptSha256);
    assert.equal(request.automaticRetries, 0);
    assert.equal(request.output.normalizeWidth, 768);
    assert.equal(request.output.normalizeHeight, 1024);
  }
});

test('stores placeholders, never credentials or image bytes, in payload templates', () => {
  const serialized = JSON.stringify(buildBenchmarkRequests());
  assert.match(serialized, /\{\{IDENTITY_/);
  assert.match(serialized, /\{\{HIGH_KICK_/);
  assert.doesNotMatch(serialized, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(serialized, /Key [0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(serialized, /data:image\/png;base64,[A-Za-z0-9+/]{100,}/);
});
