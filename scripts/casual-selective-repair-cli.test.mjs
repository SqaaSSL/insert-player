import { describe, expect, it } from 'vitest';
import { selectiveRepairOptions, assertSelectiveDispatch, assertHistoricalCrouchPose } from './casual-selective-repair-cli.mjs';
const hash = 'a'.repeat(64);
const plan = { request: { path: '/v1beta/models/gemini-3.1-flash-image:generateContent', sha256: hash } };
describe('exact Casual selective repair boundary', () => {
  it('defaults to an offline plan and refuses broader targets or duplicate options', () => {
    expect(selectiveRepairOptions([])).toMatchObject({ execute: false, target: 'all', step: 'render' });
    expect(() => selectiveRepairOptions(['--target=walk:10'])).toThrow(/Outside/);
    expect(selectiveRepairOptions(['--target=crouch:1'])).toMatchObject({ execute: false, target: 'crouch:1' });
    for (const frame of [1, 2, 3, 4, 5, 6, 7, 8]) expect(selectiveRepairOptions([`--target=ko:${frame}`])).toMatchObject({ execute: false, target: `ko:${frame}` });
    expect(() => selectiveRepairOptions(['--target=ko:9'])).toThrow(/Outside/);
    expect(selectiveRepairOptions(['--target=hit:1'])).toMatchObject({ execute: false, target: 'hit:1' });
    expect(selectiveRepairOptions(['--target=hit:2'])).toMatchObject({ execute: false, target: 'hit:2' });
    expect(() => selectiveRepairOptions(['--target=hit:3'])).toThrow(/Outside/);
    expect(() => selectiveRepairOptions(['--target=walk:8', '--target=walk:9'])).toThrow(/Duplicate/);
    expect(() => selectiveRepairOptions(['--force'])).toThrow(/Unexpected/);
  });
  it('allows the approved crouch1 historical pose only across the exact raw-preserving Rookie correction', () => {
    const originalRookie = { sha256: 'a'.repeat(64), rawPath: 'raw.png', rawSha256: 'b'.repeat(64), rawBytes: 100, rawWidth: 896, rawHeight: 1200, frameCount: 4, gridCols: 2, gridRows: 2 };
    const activeRookie = { ...originalRookie, sha256: 'c'.repeat(64), derivativeId: 'casual-postprocess-repair-v1' };
    const proof = { operation: 'reprocess-original-raw', providerCalls: 0, originalEntry: originalRookie, outputEntry: activeRookie };
    const args = { targetKey: 'crouch:1', activeRookie, originalRookie, proof, approvedReuse: true };
    expect(() => assertHistoricalCrouchPose(args)).not.toThrow();
    expect(() => assertHistoricalCrouchPose({ ...args, approvedReuse: false })).toThrow(/already reviewed/);
    expect(() => assertHistoricalCrouchPose({ ...args, targetKey: 'hit:1' })).toThrow();
    expect(() => assertHistoricalCrouchPose({ ...args, activeRookie: { ...activeRookie, rawSha256: 'd'.repeat(64) } })).toThrow(/unchanged raw/);
  });
  it('requires one exact reviewed plan and raw review before paid cleanup', () => {
    expect(() => selectiveRepairOptions(['--execute'])).toThrow(/one reviewed target/);
    expect(() => selectiveRepairOptions(['--execute', '--target=walk:8'])).toThrow();
    expect(() => selectiveRepairOptions(['--execute', '--target=walk:8', '--confirm=casual-selective-frame-repair-v1', `--plan-sha256=${hash}`, '--step=clean'])).toThrow(/RAW SHA/);
    expect(selectiveRepairOptions(['--execute', '--target=walk:8', '--confirm=casual-selective-frame-repair-v1', `--plan-sha256=${hash}`, '--step=clean', `--raw-reviewed=${hash}`])).toMatchObject({ execute: true, target: 'walk:8', step: 'clean' });
  });
  it('permits one exact body and its cache replay, never an automatic new correction', () => {
    const input = { provider: 'gemini', path: plan.request.path, bodySha256: hash, step: 'render', plan, owned: 0, exists: false };
    expect(() => assertSelectiveDispatch(input)).not.toThrow();
    expect(() => assertSelectiveDispatch({ ...input, owned: 1, exists: true })).not.toThrow();
    expect(() => assertSelectiveDispatch({ ...input, owned: 1 })).toThrow(/One provider attempt/);
    expect(() => assertSelectiveDispatch({ ...input, bodySha256: 'b'.repeat(64) })).toThrow(/exact reviewed first/);
    expect(() => assertSelectiveDispatch({ ...input, provider: 'fal' })).toThrow(/exact reviewed first/);
  });
  it('does not permit a paid renderer or fallback during cleanup', () => {
    const input = { provider: 'fal', path: '/fal-ai/birefnet', bodySha256: hash, step: 'clean', plan, owned: 0, exists: false };
    expect(() => assertSelectiveDispatch(input)).not.toThrow();
    expect(() => assertSelectiveDispatch({ ...input, provider: 'freepik' })).toThrow(/BiRefNet/);
    expect(() => assertSelectiveDispatch({ ...input, path: '/another-model' })).toThrow(/BiRefNet/);
  });
});
