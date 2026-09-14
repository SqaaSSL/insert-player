import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AURA_GRID_RESCUE_ID, AURA_GRID_FINGERPRINT, AURA_GRID_TARGETS, auraGridOptions, validateAuraGridInputs, assertAuraGridDispatch, captureAuraGridRequest } from './casual-aura-grid-rescue-cli.mjs';
import { LOCAL_ORIGIN, installCasualWindow, sha256 } from './casual-generation-transport.mjs';
import { installCanvasRuntime } from '../processor/src/canvasRuntime.ts';
import { createDetachedApiRequestContext } from '../src/services/ApiClient.ts';
import { cleanCellsWithUnionMasks, geminiRefineSpriteFrame } from '../src/services/GeminiApi.ts';

const hash = 'a'.repeat(64), identity = { slug: 'casual', sourceSha256: hash }, directories = [];
const expected = { provider: 'gemini', path: '/v1beta/models/gemini-3.1-flash-image:generateContent', sha256: hash };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function inputFixture() {
  return { schemaVersion: 1, id: AURA_GRID_RESCUE_ID, fingerprint: AURA_GRID_FINGERPRINT, identity, frames: AURA_GRID_TARGETS.map(key => {
    const [animationName, frame] = key.split(':'), uniqueFrame = Number(frame);
    return { target: { animationName, uniqueFrame, qualityTier: 'contender', playbackFrames: [uniqueFrame] }, parent: { id: hash, requestSha256: hash, responseSha256: hash }, pose: { path: `.artifacts/poses/${animationName}-${frame}.png`, sha256: hash, bytes: 500, mime: 'image/png', width: 768, height: 1024 } };
  }) };
}
describe('seven-frame Aura rescue boundary', () => {
  it('defaults offline and excludes other moves, duplicate options and batch execution', () => {
    expect(auraGridOptions([])).toMatchObject({ execute: false, target: 'all', step: 'render' });
    for (const args of [['--target=aura_unbothered:1'], ['--target=aura_floor_worm:7'], ['--target=all', '--target=aura_unbothered:2'], ['--execute'], ['--force']]) expect(() => auraGridOptions(args)).toThrow();
  });
  it('requires the exact plan and a separate RAW approval before cleanup', () => {
    const args = ['--execute', '--target=aura_unbothered:2', `--confirm=${AURA_GRID_RESCUE_ID}`, `--plan-sha256=${hash}`, '--step=clean'];
    expect(() => auraGridOptions(args)).toThrow(/RAW/);
    expect(auraGridOptions([...args, `--raw-reviewed=${hash}`])).toMatchObject({ execute: true, step: 'clean', rawReviewed: hash });
  });
  it('accepts only the exact seven-pose identity and geometry contract', () => {
    expect(() => validateAuraGridInputs(inputFixture(), identity)).not.toThrow();
    for (const mutation of [i => i.frames.pop(), i => i.frames.push(i.frames[0]), i => i.frames[0].target.uniqueFrame = 1, i => i.frames[0].pose.width = 1024, i => i.frames[0].pose.mime = 'image/jpeg', i => i.identity = { slug: 'other' }, i => i.frames[0].parent.responseSha256 = '', i => i.frames[0].target.qualityTier = 'rookie']) {
      const input = inputFixture(); mutation(input); expect(() => validateAuraGridInputs(input, identity)).toThrow();
    }
  });
  it('allows one exact dispatch and a cached replay, never another body or fallback', () => {
    const args = { provider: expected.provider, path: expected.path, bodySha256: hash, expected, owned: 0, exists: false };
    expect(() => assertAuraGridDispatch(args)).not.toThrow();
    expect(() => assertAuraGridDispatch({ ...args, owned: 1, exists: true })).not.toThrow();
    for (const change of [{ owned: 1 }, { bodySha256: 'b'.repeat(64) }, { provider: 'freepik' }, { path: '/v1beta/models/other:generateContent' }]) expect(() => assertAuraGridDispatch({ ...args, ...change })).toThrow();
    const cleanup = { provider: 'fal', path: '/fal-ai/birefnet', sha256: hash };
    expect(() => assertAuraGridDispatch({ ...args, provider: cleanup.provider, path: cleanup.path, expected: cleanup })).not.toThrow();
    expect(() => assertAuraGridDispatch({ ...args, provider: cleanup.provider, path: cleanup.path, bodySha256: 'b'.repeat(64), expected: cleanup })).toThrow(/exact reviewed/);
  });
});

describe('real product offline request capture', () => {
  async function fixture(run) {
    installCanvasRuntime(); const diagnostics = [], restore = installCasualWindow(diagnostics), dir = mkdtempSync(join(tmpdir(), 'casual-grid-offline-')); directories.push(dir);
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 96;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 64, 96); ctx.fillStyle = '#777777'; ctx.fillRect(20, 10, 24, 78);
    const pose = canvas.toDataURL('image/png').split(',')[1];
    const context = createDetachedApiRequestContext({ apiBaseUrl: LOCAL_ORIGIN, authorizationToken: 'offline-only' });
    try { await run({ dir, pose, context }); expect(existsSync(join(dir, 'provider-ledger.json'))).toBe(false); }
    finally { restore(); }
  }
  it('captures the normal pose-only Flash request without submitting or falling back', async () => {
    await fixture(async ({ dir, pose, context }) => {
      const before = globalThis.fetch;
      const captured = await captureAuraGridRequest(() => geminiRefineSpriteFrame(pose, pose, 'aura_unbothered', 'irrelevant motion', 1, 6, context, 'gemini-3.1-flash-image'), dir, 'gemini');
      expect(globalThis.fetch).toBe(before); expect(captured.path).toBe(expected.path);
      const images = captured.body.contents[0].parts.filter(part => part.inlineData);
      expect(images).toHaveLength(1); expect(sha256(Buffer.from(images[0].inlineData.data, 'base64'))).toBe(sha256(Buffer.from(pose, 'base64')));
    });
  });
  it('captures the exact BiRefNet transport body from real product cleanup without a provider or ledger', async () => {
    await fixture(async ({ dir, pose, context }) => {
      const captured = await captureAuraGridRequest(() => cleanCellsWithUnionMasks([pose], 'aura_unbothered', context), dir, 'fal');
      expect(captured.provider).toBe('fal'); expect(captured.path).toBe('/fal-ai/birefnet');
      expect(Object.keys(captured.body)).toEqual(['image_url']); expect(captured.body.image_url).toMatch(/^data:image\/jpeg;base64,/);
    });
  });
});
