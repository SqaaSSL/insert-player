import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
  HUMANOID_V4_TRUSTED_SEAL,
  HUMANOID_V5_REPLACEMENT_CONTRACT,
  HUMANOID_V5_REPLACEMENT_POSE_IDS,
  HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL,
  hardlinkOrCopyExclusive,
  loadHumanoidV5ReplacementSeal,
  parseHumanoidPostprocessCliArgs,
  readRegularFileSnapshot,
  validateHumanoidV5ReplacementSeal,
  verifyHumanoidPostprocessInputs,
  writeBytesAtomicExclusive,
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
  const workDirectory = mkdtempSync(join(realpathSync.native(tmpdir()), 'insert-player-humanoid-postprocess-'));
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

function validV5ReplacementSeal() {
  return {
    schemaVersion: 1,
    experimentId: 'humanoid-neutral-medium-xai-selective-v5',
    githubActionsRunId: '33345211634',
    generatorCommitSha: '8af2a462336263157137dab84620da4dcc9a9b12',
    githubArtifactId: '9741870159',
    githubArtifactName: 'humanoid-neutral-medium-xai-selective-v5-repair-encrypted',
    githubArtifactZipSha256: '1'.repeat(64),
    encryptedArtifactSha256: '2'.repeat(64),
    inputManifestSha256: '88db095eb86f716a798ba7c873c698ea87f1150da07d1b3909f500f39cc87578',
    inputPlanSha256: '51f7763cecb4ba9cc761846d5ae7a076660610c018bf4b180aea12eab31a8ac9',
    executionStateSha256: '3'.repeat(64),
    repairManifestSha256: '4'.repeat(64),
    repairPlanSha256: '0e5c8826b4b9f58f4c7ce3e9e485a632e38ad03d29cf6ec64374680606c7898d',
    sourceCanaryRunId: '33343450009',
    sourceCanaryGeneratorCommitSha: '0a66f1631958a5a96100eac8d39b9f9cc0cbed5f',
    sourceCanaryArtifactId: '9741312074',
    sourceCanaryArtifactZipSha256: '420adad6d1f4a97cbf18d3f00ec5f1676800f35988d97ac1d6b7d3594e840dcd',
    sourceCanaryCiphertextSha256: 'd48a3f78e0a1491fc36ca4310f723e8b9e0c00b3f4946d6970175bcacdfb293e',
    sourceCanaryStateSha256: '77f519280e9701d833362c32f9cb008a238557eb02ad921a4f432f74d9a8c867',
    replacementPoseIds: [...HUMANOID_V5_REPLACEMENT_POSE_IDS],
  };
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
  it('requires the exact trusted V4 state and manifest byte seals', () => {
    expect(HUMANOID_V4_TRUSTED_SEAL).toEqual({
      executionStateSha256: '0cd3ec47df48421b38077deb30b803a97daeb5cc8ddae786525727d29af3b5c4',
      inputManifestSha256: 'd85fb7c4b8642fd1671fc6300a084d948c53a96172630ca4177c71e9aa8814b3',
      planSha256: '6eae3d89e52a89e9e6b1c17f194ab1c93605aedb23521e2bb0dcc4a02878ff89',
      encryptedArtifactSha256: '6b38494913314b07fe0e3808f13512c0db3a0babd831daf0cf98a00163d2fab4',
      githubActionsRunId: '33340491399',
    });
    const fixture = buildSealedFixture();
    expect(() => verifyHumanoidPostprocessInputs({
      workDirectory: fixture.workDirectory,
      knownVisualFindings: [],
    })).toThrow(/execution state SHA-256 is not the exact trusted V4 state/);
  });

  it('rejects a structurally plausible state rewrite before trusting its raw hashes', () => {
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
    const statePath = join(fixture.workDirectory, 'state.json');
    const rewrittenState = JSON.parse(readFileSync(statePath, 'utf8'));
    rewrittenState.slots[pose.poseId].artifacts.image.contentSha256 = sha256(changed);
    rewrittenState.slots[pose.poseId].artifacts.image.sizeBytes = changed.byteLength;
    writeFileSync(statePath, `${JSON.stringify(rewrittenState, null, 2)}\n`);
    expect(() => verifyHumanoidPostprocessInputs({
      workDirectory: fixture.workDirectory,
      knownVisualFindings: [],
    }))
      .toThrow(/execution state SHA-256 is not the exact trusted V4 state/);
  });

  it('retains immutable bytes after a verified path is replaced', () => {
    const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'insert-player-humanoid-snapshot-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'raw.png');
    const original = fakePng('immutable-original', 1776, 2368);
    const replacement = fakePng('path-replacement', 1776, 2368);
    writeFileSync(path, original);
    const snapshot = readRegularFileSnapshot(path, 'immutable raw', { containmentRoot: directory });
    unlinkSync(path);
    writeFileSync(path, replacement);
    expect(snapshot.contentSha256).toBe(sha256(original));
    expect(snapshot.bytes.equals(original)).toBe(true);
    expect(snapshot.bytes.equals(readFileSync(path))).toBe(false);
  });

  it('rejects symlinked input paths and symlinked or pre-existing output entries', () => {
    const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'insert-player-humanoid-symlink-'));
    temporaryDirectories.push(directory);
    const inputRoot = join(directory, 'input');
    const outputRoot = join(directory, 'output');
    mkdirSync(inputRoot);
    mkdirSync(outputRoot);
    const realInput = join(inputRoot, 'real.png');
    const linkedInput = join(inputRoot, 'linked.png');
    writeFileSync(realInput, fakePng('real-input', 1776, 2368));
    symlinkSync(realInput, linkedInput);
    expect(() => readRegularFileSnapshot(linkedInput, 'linked input', { containmentRoot: inputRoot })).toThrow(/symbolic link/);

    const outside = join(directory, 'outside.txt');
    const destination = join(outputRoot, 'alias.bin');
    writeFileSync(outside, 'must-not-change');
    symlinkSync(outside, destination);
    expect(() => writeBytesAtomicExclusive(destination, Buffer.from('new bytes'), outputRoot)).toThrow(/symbolic link/);
    expect(readFileSync(outside, 'utf8')).toBe('must-not-change');
  });

  it('creates byte-identical aliases without overwriting an existing destination', () => {
    const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'insert-player-humanoid-alias-'));
    temporaryDirectories.push(directory);
    const outputRoot = join(directory, 'output');
    mkdirSync(outputRoot);
    const master = join(outputRoot, 'master.bin');
    const firstAlias = join(outputRoot, 'frames', 'alias-a.bin');
    const secondAlias = join(outputRoot, 'frames', 'alias-b.bin');
    const bytes = Buffer.from('sealed-alias-bytes');
    writeBytesAtomicExclusive(master, bytes, outputRoot);
    const expectedHash = sha256(bytes);
    hardlinkOrCopyExclusive(master, firstAlias, outputRoot, expectedHash);
    hardlinkOrCopyExclusive(master, secondAlias, outputRoot, expectedHash);
    expect(readFileSync(firstAlias).equals(bytes)).toBe(true);
    expect(readFileSync(secondAlias).equals(bytes)).toBe(true);
    expect(sha256(readFileSync(firstAlias))).toBe(sha256(readFileSync(secondAlias)));
    expect(() => hardlinkOrCopyExclusive(master, firstAlias, outputRoot, expectedHash)).toThrow(/Refusing to replace output existing entry/);
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
    expect(Object.keys(parsed).sort()).toEqual([
      'ffmpegBinary',
      'outputDirectory',
      'replacementSealPath',
      'replacementSealSha256',
      'replacementWorkDirectory',
      'workDirectory',
    ]);
    expect(parsed.replacementWorkDirectory).toBeNull();
  });

  it('freezes the exact 24/70 combined contract and requires one complete out-of-band seal', () => {
    expect(HUMANOID_V5_REPLACEMENT_POSE_IDS).toHaveLength(24);
    expect(new Set(HUMANOID_V5_REPLACEMENT_POSE_IDS).size).toBe(24);
    expect(HUMANOID_V5_REPLACEMENT_CONTRACT).toMatchObject({
      replacementPoseCount: 24,
      retainedV4PoseCount: 70,
      combinedPoseCount: 94,
      repairPaidCalls: 19,
      repairCostMicrocredits: 1_900_000,
      combinedCostMicrocredits: 2_400_000,
      repairPlanVerification: 'recomputed_from_sealed_linux_manifest',
    });
    expect(HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL).toMatchObject({
      contentSha256: 'd4a2b9a3094bde41eb32b0d2d7d7ac9f3a393169450825ec9bc3281254db5521',
      githubActionsRunId: '33345211634',
      githubArtifactId: '9741870159',
    });
    expect(loadHumanoidV5ReplacementSeal({
      sealPath: HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.path,
      expectedSealSha256: HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.contentSha256,
    }).seal.repairPlanSha256).toBe('0e5c8826b4b9f58f4c7ce3e9e485a632e38ad03d29cf6ec64374680606c7898d');
    expect(validateHumanoidV5ReplacementSeal(validV5ReplacementSeal()).replacementPoseIds).toHaveLength(24);
    expect(() => validateHumanoidV5ReplacementSeal({
      ...validV5ReplacementSeal(),
      replacementPoseIds: HUMANOID_V5_REPLACEMENT_POSE_IDS.slice(1),
    })).toThrow(/replacement pose set changed/);
    const combined = parseHumanoidPostprocessCliArgs([
      '--work-dir=/private/tmp/sealed-humanoid',
      '--replacement-work-dir=/private/tmp/v5',
    ]);
    expect(combined.replacementSealSha256).toBe(HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.contentSha256);
    expect(combined.replacementSealPath).toBe(HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.path);
    expect(() => parseHumanoidPostprocessCliArgs([
      '--work-dir=/private/tmp/sealed-humanoid',
      '--replacement-work-dir=/private/tmp/v5',
      '--replacement-seal=/private/tmp/custom-seal.json',
      `--replacement-seal-sha256=${'a'.repeat(64)}`,
    ])).toThrow(/Custom V5 trust seals are forbidden/);
  });

  it('rejects a replacement trust-seal byte change before reading any replacement work directory', () => {
    const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'insert-player-humanoid-v5-seal-'));
    temporaryDirectories.push(directory);
    const sealPath = join(directory, 'trusted-seal.json');
    const bytes = Buffer.from(`${JSON.stringify(validV5ReplacementSeal(), null, 2)}\n`);
    writeFileSync(sealPath, bytes);
    const loaded = loadHumanoidV5ReplacementSeal({ sealPath, expectedSealSha256: sha256(bytes) });
    expect(loaded.sealSha256).toBe(sha256(bytes));
    writeFileSync(sealPath, Buffer.concat([bytes, Buffer.from(' ')]));
    expect(() => loadHumanoidV5ReplacementSeal({ sealPath, expectedSealSha256: sha256(bytes) }))
      .toThrow(/trust-seal bytes changed/);
  });
});
