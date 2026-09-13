import { describe, expect, it } from 'vitest';
import { replaceOnlyCrouchPostprocess } from './repair-casual-crouch-postprocess.mjs';
import { CASUAL_POSTPROCESS_REPAIR_ID as ID } from './casual-postprocess-repair-provenance.mjs';
function fixture() {
  const original = { animationName: 'crouch', qualityTier: 'rookie', path: 'outputs/old.png', sha256: 'old-sha', bytes: 123,
    mime: 'image/png', animationFormat: 'legacy', processingVersion: 5, frameWidth: 768, frameHeight: 1024, frameCount: 4,
    gridCols: 2, gridRows: 2, rawPath: 'outputs/original-raw.png', rawSha256: 'raw-sha', rawBytes: 456,
    rawWidth: 896, rawHeight: 1200, rawMime: 'image/png', debugPath: 'original-generation-notes.json' };
  const output = { ...original, path: `derivatives/${ID}/outputs/new.png`, sha256: 'new-sha', bytes: 125, derivativeId: ID };
  const derivative = { id: ID, path: `derivatives/${ID}/provenance.json`, sha256: 'proof-sha', bytes: 100, mime: 'application/json' };
  const others = [{ animationName: 'idle', qualityTier: 'rookie', derivativeId: 'casual-idle-closed-loop-v1', sha256: 'idle-preserved' },
    { animationName: 'crouch', qualityTier: 'contender', sha256: 'champion-preserved' }];
  const manifest = { fingerprint: 'unchanged-product', sources: [{ kind: 'original', sha256: 'source-preserved' }],
    phaseStatus: { full: 'incomplete' }, sprites: [others[0], original, others[1]], derivatives: [{ id: 'casual-idle-closed-loop-v1' }] };
  return { original, output, derivative, manifest, others };
}
describe('offline Rookie crouch replacement', () => {
  it('changes only the reviewed processed entry and adds its proof without mutating the source manifest', () => {
    const f = fixture(), before = JSON.stringify(f.manifest);
    const next = replaceOnlyCrouchPostprocess(f.manifest, f.original, f.output, f.derivative);
    expect(JSON.stringify(f.manifest)).toBe(before);
    expect(next.sprites[1]).toEqual(f.output); expect(next.sprites[0]).toEqual(f.others[0]); expect(next.sprites[2]).toEqual(f.others[1]);
    expect(next.sources).toEqual(f.manifest.sources); expect(next.fingerprint).toBe(f.manifest.fingerprint); expect(next.phaseStatus).toEqual(f.manifest.phaseStatus);
    expect(next.derivatives).toEqual([...f.manifest.derivatives, f.derivative]);
  });
  it.each(['rawPath', 'rawSha256', 'rawBytes', 'rawWidth', 'rawHeight', 'rawMime', 'frameCount', 'processingVersion', 'qualityTier'])('refuses a hidden change to %s', field => {
    const f = fixture(); f.output[field] = typeof f.output[field] === 'number' ? f.output[field] + 1 : 'different';
    expect(() => replaceOnlyCrouchPostprocess(f.manifest, f.original, f.output, f.derivative)).toThrow(`Original ${field} must remain unchanged`);
  });
  it('refuses to overwrite a newer source entry or apply twice', () => {
    const f = fixture(); f.manifest.sprites[1] = { ...f.original, sha256: 'newer-output' };
    expect(() => replaceOnlyCrouchPostprocess(f.manifest, f.original, f.output, f.derivative)).toThrow('reviewed source sprite changed');
    f.manifest.sprites[1] = f.original; f.manifest.derivatives.push(f.derivative);
    expect(() => replaceOnlyCrouchPostprocess(f.manifest, f.original, f.output, f.derivative)).toThrow();
  });
});
