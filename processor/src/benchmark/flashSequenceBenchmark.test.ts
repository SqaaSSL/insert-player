import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD,
  FLASH_SEQUENCE_HARD_CAP_USD,
  HIGH_KICK_ANCHORS,
  HIGH_KICK_PLAYBACK_ORDER,
  buildFlashSequenceRequests,
  flashSequenceGuardedBudgetUsd,
  validateFlashSequencePlan,
} from './flashSequenceBenchmark.ts';

test('freezes four unique anchors and the mirrored seven-frame playback', () => {
  assert.deepEqual(HIGH_KICK_ANCHORS.map((anchor) => anchor.frameIndex), [0, 1, 2, 3]);
  assert.deepEqual([...HIGH_KICK_PLAYBACK_ORDER], [0, 1, 2, 3, 2, 1, 0]);
});

test('reuses the existing impact and keeps the billing-corrected guard below the approved cap', () => {
  validateFlashSequencePlan();
  const requests = buildFlashSequenceRequests();
  assert.equal(requests.filter((request) => request.kind === 'generation').length, 3);
  assert.equal(requests.filter((request) => request.kind === 'cleanup').length, 4);
  assert.equal(flashSequenceGuardedBudgetUsd(), 0.048);
  assert.equal(FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD, 0.057);
  assert.ok(FLASH_SEQUENCE_BILLING_CORRECTED_GUARD_USD <= FLASH_SEQUENCE_HARD_CAP_USD);
});
