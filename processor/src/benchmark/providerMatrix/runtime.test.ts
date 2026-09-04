import assert from 'node:assert/strict';
import test from 'node:test';
import { executePlan, geminiAspectRatio } from './runtime.ts';

test('Gemini direct-sheet aspect ratio follows the animation-specific canvas', () => {
  assert.equal(geminiAspectRatio(1728, 2304), '3:4');
  assert.equal(geminiAspectRatio(2432, 1632), '3:2');
});

test('closed paid gates fail before filesystem preparation, secrets, pricing, or provider fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('network must not be reached');
  }) as typeof fetch;
  try {
    await assert.rejects(
      executePlan({
        rendererId: 'klein-9b',
        strategyId: 'previous-delta',
        animationId: 'high_kick',
        throughFrame: 2,
        confirmation: 'trump-provider-strategy-matrix-20260824-v1:klein-9b:previous-delta:high_kick',
        maxCostUsd: 0.069,
      }),
      /not explicitly approved/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-HIGH_KICK paid execution is locked before provider access', async () => {
  await assert.rejects(
    executePlan({
      rendererId: 'klein-9b',
      strategyId: 'previous-delta',
      animationId: 'walk',
      throughFrame: 1,
      confirmation: 'irrelevant',
      maxCostUsd: 0.1,
    }),
    /currently locked to HIGH_KICK/,
  );
});
