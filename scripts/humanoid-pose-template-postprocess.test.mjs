import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HUMANOID_POSTPROCESS_CANVAS,
  analyzeForeground,
  applyUniformTransform,
  buildCheckerboardContactSheet,
  compositeRgbaOnPureChroma,
  computeRegistrationTransform,
  decontaminateGreenEdges,
  evaluatePostprocessMetrics,
  isFloodFillGreen,
  keyHumanoidChroma,
  scaleSourceBbox,
} from './humanoid-pose-template-postprocess-core.mjs';
import {
  HUMANOID_POSTPROCESS_KNOWN_VISUAL_FINDINGS,
  HUMANOID_POSTPROCESS_POLICY,
  parseHumanoidPostprocessCliArgs,
  verifyHumanoidPostprocessInputs,
} from './humanoid-pose-template-postprocess.mjs';

const temporaryDirectories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function fakePng(label, width, height, colorType = 2) {
  const bytes = Buffer.alloc(96);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = colorType;
  Buffer.from(label).copy(bytes, 33, 0, Math.min(Buffer.byteLength(label), 63));
  return bytes;
}

function buildSealedFixture() {
  const workDirectory = mkdtempSync(join(tmpdir(), 'insert-player-humanoid-postprocess-'));
  temporaryDirectories.push(workDirectory);
  const inputDirectory = join(workDirectory, 'inputs');
  const experimentId = 'humanoid-neutral-medium-xai-template-v4';
  const model = { id: 'grok-imagine-image-2-edit' };
  mkdirSync(join(inputDirectory, 'poses'), { recursive: true });
  mkdirSync(join(workDirectory, 'outputs', experimentId), { recursive: true });
  const uniquePoses = [];
  const frameSlots = [];
  const slots = {};
  for (let index = 1; index <= 94; index += 1) {
    const poseId = `pose-${String(index).padStart(3, '0')}-${index.toString(16).padStart(12, '0')}`;
    const sourceBytes = fakePng(`source-${poseId}`, 768, 1024);
    const sourcePath = `poses/${poseId}.png`;
    writeFileSync(join(inputDirectory, sourcePath), sourceBytes);
    const sourceSlots = [{ animationName: 'idle', frameNumber: index }];
    if (index <= 4) sourceSlots.push({ animationName: 'walk', frameNumber: 94 + index });
    uniquePoses.push({
      poseId,
      path: sourcePath,
      contentSha256: sha256(sourceBytes),
      sourceSlots,
    });
    for (const sourceSlot of sourceSlots) frameSlots.push({ ...sourceSlot, poseId });
    const rawBytes = fakePng(`raw-${poseId}`, 1776, 2368);
    const rawName = `${poseId}--${model.id}--image.png`;
    writeFileSync(join(workDirectory, 'outputs', experimentId, rawName), rawBytes);
    slots[poseId] = {
      status: 'completed',
      artifacts: {
        image: {
          path: `.humanoid-template-v4-work/outputs/${experimentId}/${rawName}`,
          mimeType: 'image/png',
          width: 1776,
          height: 2368,
          sizeBytes: rawBytes.byteLength,
          contentSha256: sha256(rawBytes),
        },
      },
    };
  }
  const manifestCore = {
    schemaVersion: 2,
    experimentId,
    model,
    uniquePoses,
    frameSlots,
  };
  const manifest = { ...manifestCore, planSha256: sha256(canonicalJson(manifestCore)) };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(inputDirectory, 'input-manifest.json'), manifestBytes);
  const state = {
    experimentId,
    planSha256: manifest.planSha256,
    manifestSha256: sha256(manifestBytes),
    status: 'full_complete_human_review_required',
    completedPoseCount: 94,
    slots,
  };
  writeFileSync(join(workDirectory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return { workDirectory, manifest, state };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe('humanoid V4 deterministic postprocess core', () => {
  it('keys dark edge-connected greens without using a luminosity threshold and preserves neutral pixels', () => {
    expect(isFloodFillGreen(1, 22, 2)).toBe(true);
    const width = 5;
    const height = 5;
    const rgb = Buffer.alloc(width * height * 3);
    for (let offset = 0; offset < rgb.length; offset += 3) rgb.set([1, 22, 2], offset);
    rgb.set([120, 120, 120], (2 * width + 2) * 3);
    rgb.set([0, 255, 0], (2 * width + 1) * 3);
    const { rgba } = keyHumanoidChroma(rgb, width, height);
    expect(rgba[3]).toBe(0);
    expect(rgba[(2 * width + 1) * 4 + 3]).toBe(0);
    expect(Array.from(rgba.slice((2 * width + 2) * 4, (2 * width + 2) * 4 + 4))).toEqual([120, 120, 120, 255]);
  });

  it('keeps disconnected neutral ambiguity for review instead of deleting it', () => {
    const width = 7;
    const height = 5;
    const rgb = Buffer.alloc(width * height * 3);
    for (let offset = 0; offset < rgb.length; offset += 3) rgb.set([0, 255, 0], offset);
    for (const [x, y] of [[1, 2], [2, 2], [5, 3]]) rgb.set([90, 90, 90], (y * width + x) * 3);
    const keyed = keyHumanoidChroma(rgb, width, height);
    const analysis = analyzeForeground(keyed.rgba, width, height);
    expect(analysis.totalPixels).toBe(3);
    expect(analysis.componentCount).toBe(2);
    expect(analysis.largestComponentRatio).toBeCloseTo(2 / 3);
  });

  it('reuses decontamination without eroding a one-pixel finger', () => {
    const rgba = new Uint8ClampedArray(7 * 5 * 4);
    for (const [x, y] of [[3, 1], [3, 2], [3, 3]]) rgba.set([180, 80, 60, 255], (y * 7 + x) * 4);
    rgba.set([10, 220, 10, 180], (2 * 7 + 4) * 4);
    decontaminateGreenEdges(rgba, 7, 5);
    expect([1, 2, 3].map((y) => rgba[(y * 7 + 3) * 4 + 3])).toEqual([255, 255, 255]);
    expect(rgba[(2 * 7 + 4) * 4 + 3]).toBe(180);
  });

  it('scales source bbox edges by exactly 37/16', () => {
    expect(scaleSourceBbox({ x: 100, y: 80, w: 240, h: 700 })).toEqual({
      x: 231,
      y: 185,
      w: 555,
      h: 1619,
    });
    expect(HUMANOID_POSTPROCESS_CANVAS.outputWidth / HUMANOID_POSTPROCESS_CANVAS.sourceWidth).toBe(37 / 16);
    expect(HUMANOID_POSTPROCESS_CANVAS.outputHeight / HUMANOID_POSTPROCESS_CANVAS.sourceHeight).toBe(37 / 16);
  });

  it('uses one uniform scale and the required vertical and KO anchors', () => {
    const generated = { x: 200, y: 300, w: 400, h: 1000 };
    const target = { x: 300, y: 200, w: 500, h: 800 };
    const vertical = computeRegistrationTransform({ generatedBbox: generated, targetBbox: target, mode: 'vertical' });
    expect(vertical.scale).toBe(0.8);
    expect(vertical.translateY + generated.y * vertical.scale).toBe(200);
    expect(vertical.translateX + (generated.x + generated.w / 2) * vertical.scale).toBe(550);
    const horizontal = computeRegistrationTransform({ generatedBbox: generated, targetBbox: target, mode: 'horizontal' });
    expect(horizontal.scale).toBe(1.25);
    expect(horizontal.translateX + generated.x * horizontal.scale).toBe(300);
    expect(horizontal.translateY + (generated.y + generated.h) * horizontal.scale).toBe(1000);
  });

  it('registers with a single affine scale and retains transparent corners', () => {
    const width = 12;
    const height = 12;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 3; y < 7; y += 1) {
      for (let x = 4; x < 6; x += 1) rgba.set([180, 80, 60, 255], (y * width + x) * 4);
    }
    const before = analyzeForeground(rgba, width, height);
    const target = { x: 5, y: 2, w: 2, h: 6 };
    const transform = computeRegistrationTransform({ generatedBbox: before.largestComponentBbox, targetBbox: target, mode: 'vertical' });
    const output = applyUniformTransform(rgba, width, height, transform, before.allForegroundBbox);
    const after = analyzeForeground(output, width, height);
    expect(transform.scale).toBe(1.5);
    expect(Math.abs(after.largestComponentBbox.h - target.h)).toBeLessThanOrEqual(2);
    expect(output[3]).toBe(0);
    expect(output.at(-1)).toBe(0);
  });

  it('applies review and hard thresholds without silently approving drift', () => {
    const base = {
      totalPixels: 100,
      largestComponentRatio: 0.80,
      significantSecondaryComponents: 1,
      touchesEdge: false,
    };
    const after = {
      totalPixels: 100,
      largestComponentBbox: { x: 0, y: 0, w: 105, h: 200 },
      greenSpillRatio: 0.05,
      touchesEdge: false,
    };
    const result = evaluatePostprocessMetrics({
      before: base,
      after,
      targetBbox: { x: 0, y: 0, w: 100, h: 200 },
      transform: { scale: 0.8 },
      mode: 'vertical',
    });
    expect(result.hardFailures).toEqual([]);
    expect(result.reviewReasons.join(' ')).toContain('largest_component_ratio');
    expect(result.reviewReasons.join(' ')).toContain('green_spill_ratio');
    expect(result.reviewReasons.join(' ')).toContain('ambiguous_disconnected_components');
  });

  it('emits exact RGB24 chroma and checkerboard QA pixels', () => {
    const rgba = Uint8ClampedArray.from([
      10, 20, 30, 0,
      255, 0, 0, 255,
      255, 0, 0, 128,
    ]);
    expect([...compositeRgbaOnPureChroma(rgba, 3, 1)]).toEqual([
      0, 255, 0,
      255, 0, 0,
      128, 127, 0,
    ]);
    const sheet = buildCheckerboardContactSheet([Uint8ClampedArray.from([0, 0, 0, 0])], 1, 1);
    expect([...sheet.rgb]).toEqual([220, 220, 220]);
  });
});

describe('humanoid V4 postprocess sealed input contract', () => {
  it('accepts exactly 94 raw poses, 98 slots, and four byte-sharing aliases', () => {
    const fixture = buildSealedFixture();
    const verified = verifyHumanoidPostprocessInputs({
      workDirectory: fixture.workDirectory,
      expectedPlanSha256: fixture.manifest.planSha256,
      knownVisualFindings: [],
    });
    expect(verified.verified).toHaveLength(94);
    expect(verified.manifest.frameSlots).toHaveLength(98);
    expect(verified.aliasPoseIds).toHaveLength(4);
  });

  it('rejects one changed raw byte before any postprocess output is created', () => {
    const fixture = buildSealedFixture();
    const pose = fixture.manifest.uniquePoses[0];
    const rawPath = join(
      fixture.workDirectory,
      'outputs',
      fixture.manifest.experimentId,
      `${pose.poseId}--${fixture.manifest.model.id}--image.png`,
    );
    const changed = fakePng('changed-after-state-seal', 1776, 2368);
    writeFileSync(rawPath, changed);
    expect(() => verifyHumanoidPostprocessInputs({
      workDirectory: fixture.workDirectory,
      expectedPlanSha256: fixture.manifest.planSha256,
      knownVisualFindings: [],
    }))
      .toThrow(/raw bytes differ from execution state/);
  });

  it('has no provider, publish, import, activation, or retry path', () => {
    expect(HUMANOID_POSTPROCESS_POLICY).toEqual({
      providerCalls: 0,
      inference: false,
      publish: false,
      import: false,
      activation: false,
      rawMutation: false,
      automaticRetry: false,
      humanReviewRequired: true,
      automatedSemanticApproval: false,
    });
    expect(HUMANOID_POSTPROCESS_KNOWN_VISUAL_FINDINGS).toHaveLength(31);
    expect(HUMANOID_POSTPROCESS_KNOWN_VISUAL_FINDINGS.filter((finding) => finding.category === 'outfit')).toHaveLength(8);
    expect(HUMANOID_POSTPROCESS_KNOWN_VISUAL_FINDINGS.filter((finding) => finding.category === 'pose')).toHaveLength(23);
    const parsed = parseHumanoidPostprocessCliArgs([
      '--work-dir=/private/tmp/sealed-humanoid',
      '--output-dir=/private/tmp/sealed-humanoid-postprocessed',
    ]);
    expect(Object.keys(parsed).sort()).toEqual(['ffmpegBinary', 'outputDirectory', 'workDirectory']);
  });
});
