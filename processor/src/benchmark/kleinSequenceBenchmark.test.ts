import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KLEIN_SEQUENCE_HARD_CAP_USD,
  KLEIN_VARIANTS,
  buildKleinSequenceRequests,
  kleinSequenceGuardedBudgetUsd,
  validateKleinSequencePlan,
} from './kleinSequenceBenchmark.ts';

test('freezes the two Klein variants and their paid request counts', () => {
  validateKleinSequencePlan();
  assert.deepEqual(KLEIN_VARIANTS.map((variant) => variant.id), ['klein-4b', 'klein-9b']);
  const requests = buildKleinSequenceRequests();
  assert.equal(requests.filter((request) => request.kind === 'generation').length, 6);
  assert.equal(requests.filter((request) => request.kind === 'cleanup').length, 8);
});

test('keeps the empirical billing guard below the approved cap', () => {
  assert.equal(kleinSequenceGuardedBudgetUsd(), 0.197);
  assert.ok(kleinSequenceGuardedBudgetUsd() <= KLEIN_SEQUENCE_HARD_CAP_USD);
});
