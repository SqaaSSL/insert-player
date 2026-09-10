#!/usr/bin/env node
// Read-only reproducibility audit. Requires the existing processor dependencies.
// node --experimental-strip-types scripts/audit-aura-pose-templates.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AURA_POSE_TEMPLATES } from '../src/game/aura/AuraPoseTemplates.ts';
import { calibrateAuraAtlas } from '../src/game/aura/AuraPoseCalibration.ts';

const processorRequire = createRequire(new URL('../processor/package.json', import.meta.url));
const { createCanvas, loadImage } = processorRequire('@napi-rs/canvas');
const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const results = [];
const DESIRED_BODY_HEIGHT = 200;
const WORLD_ROOT = { x: 310, y: 450 };
const EPSILON = 1e-9;

// Independent decoder/measurement: do not feed the recorded template boxes as
// fake Trump geometry. No output image is created or written.
async function measureFrames(bytes, reference, label) {
  const image = await loadImage(bytes);
  const { frameWidth, frameHeight } = reference;
  assert.equal(image.width, frameWidth * 4, `${label}: unexpected atlas columns`);
  assert.equal(image.height, frameHeight * 2, `${label}: unexpected atlas rows`);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const measured = [];
  for (let index = 0; index < 8; index++) {
    const offsetX = (index % 4) * frameWidth;
    const offsetY = Math.floor(index / 4) * frameHeight;
    let left = frameWidth; let top = frameHeight; let right = -1; let bottom = -1;
    for (let y = 0; y < frameHeight; y++) {
      for (let x = 0; x < frameWidth; x++) {
        if (pixels[((offsetY + y) * image.width + offsetX + x) * 4 + 3] < 32) continue;
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
    assert.ok(right >= left && bottom >= top, `${label}/${index}: empty frame`);
    measured.push({ x: left, y: top, w: right - left + 1, h: bottom - top + 1 });
  }
  return measured;
}

function residualSummary(frames) {
  const closed = [...frames, frames[0]];
  const summary = {};
  for (const field of ['heightErrorRatio', 'centerErrorBodyHeights', 'rootErrorBodyHeights']) {
    summary[field] = {
      maxAbsolute: Math.max(...closed.map(frame => Math.abs(frame[field]))),
      maxAdjacentDriftIncludingLoop: Math.max(...closed.slice(1).map((frame, index) => Math.abs(frame[field] - closed[index][field]))),
    };
  }
  return summary;
}

function auditProjection(animation, reference, measured, subject) {
  const trump = subject === 'donald-trump';
  const input = {
    name: animation, contentHash: trump ? reference.trumpSha256 : reference.templateSha256,
    frameWidth: reference.frameWidth, frameHeight: reference.frameHeight, frameCount: 8,
    bounds: measured.map(box => ({ x: box.x, y: box.y, width: box.w, height: box.h })),
  };
  // Deliberately unrelated fallback: the known hash must select template policy.
  const result = calibrateAuraAtlas(input, { bodyHeightRatio: 0.9, rootXRatio: 0.5, rootYRatio: 1 });
  assert.equal(result.policy, 'template-pose-v1', `${animation}/${subject}: unexpected fallback`);
  assert.equal(result.frames.length, 8);
  assert.equal(result.referenceBodyHeight, reference.referenceBodyHeight);
  assert.notEqual(result.audit?.verdict, 'rejected');
  assert.deepEqual(result.audit?.rejectedFrameIndices, []);
  assert.equal(result.audit?.frames.length, 9, 'Loop closure must be audited');
  const displayScale = DESIRED_BODY_HEIGHT / reference.referenceBodyHeight;
  const projections = result.frames.map((frame, index) => {
    const sourceIndex = trump ? reference.trumpSourceFrameIndices?.[index] ?? index : index;
    const targetIndex = trump ? reference.trumpTargetFrameIndices?.[index] ?? index : index;
    assert.equal(frame.sourceFrame, sourceIndex, `${animation}/${subject}/${index}: source remap`);
    const source = measured[sourceIndex];
    const original = measured[index];
    const target = reference.frames[targetIndex];
    const sourceCenter = source.x + source.w / 2;
    const sourceBottom = source.y + source.h;
    const targetCenter = target.x + target.w / 2;
    const targetBottom = target.y + target.h;
    const projectedHeight = source.h * frame.scale * displayScale;
    const projectedCenter = WORLD_ROOT.x + frame.offsetX * displayScale
      + (sourceCenter - frame.originX * reference.frameWidth) * frame.scale * displayScale;
    const projectedBottom = WORLD_ROOT.y + frame.offsetY * displayScale
      + (sourceBottom - frame.originY * reference.frameHeight) * frame.scale * displayScale;
    const expectedHeight = DESIRED_BODY_HEIGHT * target.h / reference.referenceBodyHeight;
    const expectedCenter = WORLD_ROOT.x + (targetCenter - reference.referenceRoot.x) * displayScale;
    const expectedBottom = WORLD_ROOT.y + (targetBottom - reference.referenceRoot.y) * displayScale;
    assert.ok(Math.abs(projectedHeight - expectedHeight) < EPSILON, `${animation}/${subject}/${index}: world height`);
    assert.ok(Math.abs(projectedCenter - expectedCenter) < EPSILON, `${animation}/${subject}/${index}: world center`);
    assert.ok(Math.abs(projectedBottom - expectedBottom) < EPSILON, `${animation}/${subject}/${index}: world root`);
    assert.ok(Math.abs(projectedBottom - WORLD_ROOT.y) < EPSILON, `${animation}/${subject}/${index}: authored constant root`);
    return {
      frameIndex: index, sourceFrameIndex: sourceIndex, targetFrameIndex: targetIndex,
      originalMeasuredBox: original, reviewedSourceBox: source,
      beforeOriginalHeightRatio: original.h / reference.referenceBodyHeight,
      beforeReviewedHeightRatio: source.h / reference.referenceBodyHeight,
      expectedHeightRatio: target.h / reference.referenceBodyHeight,
      projectedHeightRatio: projectedHeight / DESIRED_BODY_HEIGHT,
      projectedHeight, expectedHeight, projectedCenter, expectedCenter, projectedBottom, expectedBottom,
      before: {
        heightErrorRatio: source.h / target.h - 1,
        centerErrorBodyHeights: (sourceCenter - targetCenter) / reference.referenceBodyHeight,
        rootErrorBodyHeights: (sourceBottom - targetBottom) / reference.referenceBodyHeight,
      },
      after: {
        heightErrorRatio: projectedHeight / expectedHeight - 1,
        centerErrorBodyHeights: (projectedCenter - expectedCenter) / DESIRED_BODY_HEIGHT,
        rootErrorBodyHeights: (projectedBottom - expectedBottom) / DESIRED_BODY_HEIGHT,
      },
    };
  });
  const after = residualSummary(projections.map(frame => frame.after));
  for (const values of Object.values(after)) {
    assert.ok(values.maxAbsolute < EPSILON);
    assert.ok(values.maxAdjacentDriftIncludingLoop < EPSILON);
  }
  if (trump && animation === 'aura_one_leg') {
    assert.deepEqual(result.frames[0], result.frames[7], 'Neutral hold must use identical scale/root');
    assert.equal(projections[0].projectedHeight, projections[7].projectedHeight);
  }
  return {
    subject, policy: result.policy, verdict: result.audit.verdict, rejectedFrameIndices: [],
    shapeWarningFrameIndices: result.audit.shapeMismatchFrameIndices.filter(index => index < 8),
    calibrationResidualAudit: { before: result.audit.before, after: result.audit.after },
    independentProjectionResidual: { before: residualSummary(projections.map(frame => frame.before)), after },
    frames: projections,
  };
}

for (const [animation, reference] of Object.entries(AURA_POSE_TEMPLATES)) {
  const templatePath = `public/assets/aura/template-zero/${animation}.png`;
  const trumpPath = `public/assets/aura/donald-trump/${animation}.png`;
  const [templateBytes, trumpBytes, manifestBytes, qaBytes, reportBytes] = await Promise.all([
    readFile(resolve(root, templatePath)),
    readFile(resolve(root, trumpPath)),
    readFile(resolve(root, `artifacts/aura-animation-canary/template-zero/${animation}/manifest.json`)),
    readFile(resolve(root, `artifacts/aura-animation-canary/template-zero/${animation}/qa.json`)),
    readFile(resolve(root, `artifacts/aura-animation-canary/donald-trump/${animation}/champion/processed/report.json`)),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const qa = JSON.parse(qaBytes);
  const report = JSON.parse(reportBytes);
  assert.equal(sha256(templateBytes), reference.templateSha256, `${animation}: template bytes changed`);
  assert.equal(sha256(trumpBytes), reference.trumpSha256, `${animation}: Trump bytes changed`);
  assert.equal(manifest.runtime.sha256, reference.templateSha256, `${animation}: template provenance changed`);
  assert.equal(report.runtimeAtlas.sha256, reference.trumpSha256, `${animation}: Trump provenance changed`);
  assert.deepEqual(reference.referenceRoot, {
    x: qa.registrationTarget.rootX,
    y: qa.registrationTarget.baselineY + 1,
  }, `${animation}: root must retain the authored support contract`);
  assert.equal(reference.frames.length, 8);
  const [measured, measuredTrump] = await Promise.all([
    measureFrames(templateBytes, reference, `${animation}/template-zero`),
    measureFrames(trumpBytes, reference, `${animation}/donald-trump`),
  ]);
  for (const [index, box] of measured.entries()) {
    assert.equal(box.y + box.h, reference.referenceRoot.y, `${animation}/${index}: support baseline changed`);
  }
  assert.deepEqual(measured, reference.frames, `${animation}: alpha-32 pose bounds changed`);
  const neutralHeights = reference.referenceFrameIndices.map(index => measured[index].h).sort((a, b) => a - b);
  const median = (neutralHeights[Math.floor((neutralHeights.length - 1) / 2)]
    + neutralHeights[Math.ceil((neutralHeights.length - 1) / 2)]) / 2;
  assert.equal(median, reference.referenceBodyHeight, `${animation}: neutral median changed`);
  if (animation === 'aura_one_leg') {
    assert.deepEqual(reference.trumpSourceFrameIndices, [7, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(reference.trumpTargetFrameIndices, reference.trumpSourceFrameIndices);
  } else {
    assert.equal(reference.trumpSourceFrameIndices, undefined);
    assert.equal(reference.trumpTargetFrameIndices, undefined);
  }
  results.push({ animation, referenceBodyHeight: median, referenceRoot: reference.referenceRoot,
    measuredBoxes: measured, poseRatios: measured.map(box => box.h / median),
    templateSha256: reference.templateSha256, trumpSha256: reference.trumpSha256,
    calibration: [
      auditProjection(animation, reference, measured, 'template-zero'),
      auditProjection(animation, reference, measuredTrump, 'donald-trump'),
    ],
  });
}

console.log(JSON.stringify({ status: 'pass', alphaThreshold: 32, actions: results.length,
  frames: results.reduce((count, result) => count + result.measuredBoxes.length, 0),
  projectedFrames: results.reduce((count, result) => count + result.calibration.reduce((sum, subject) => sum + subject.frames.length, 0), 0),
  desiredStandingBodyHeight: DESIRED_BODY_HEIGHT, worldRoot: WORLD_ROOT,
  bitmapBytesChanged: 0,
  writes: 0, results }, null, 2));
