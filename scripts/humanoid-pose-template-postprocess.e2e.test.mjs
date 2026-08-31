import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HUMANOID_V4_TRUSTED_SEAL,
  HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL,
  loadHumanoidV5ReplacementSeal,
  postprocessHumanoidTemplate,
  verifyHumanoidCombinedPostprocessInputs,
  verifyHumanoidPostprocessInputs,
} from './humanoid-pose-template-postprocess.mjs';

const configuredWorkDirectory = process.env.HUMANOID_V4_E2E_WORK_DIR
  ? realpathSync.native(process.env.HUMANOID_V4_E2E_WORK_DIR)
  : null;
const fullArtifactAvailable = configuredWorkDirectory !== null && existsSync(configuredWorkDirectory);
const describeFullArtifact = fullArtifactAvailable ? describe : describe.skip;
const configuredReplacementWorkDirectory = process.env.HUMANOID_V5_REPLACEMENT_E2E_WORK_DIR
  ? realpathSync.native(process.env.HUMANOID_V5_REPLACEMENT_E2E_WORK_DIR)
  : null;
const replacementArtifactAvailable = configuredReplacementWorkDirectory !== null && existsSync(configuredReplacementWorkDirectory);
const describeCombinedArtifact = fullArtifactAvailable && replacementArtifactAvailable ? describe : describe.skip;
const temporaryDirectories = [];
const postprocessScript = fileURLToPath(new URL('./humanoid-pose-template-postprocess.mjs', import.meta.url));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function hardlinkTree(source, destination) {
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Full V4 fixture unexpectedly contains a symlink: ${sourcePath}`);
    if (entry.isDirectory()) hardlinkTree(sourcePath, destinationPath);
    else if (entry.isFile()) linkSync(sourcePath, destinationPath);
    else throw new Error(`Full V4 fixture contains an unsupported entry: ${sourcePath}`);
  }
}

function cloneFullArtifact() {
  const parent = temporaryDirectory('insert-player-humanoid-v4-e2e-clone-');
  const workDirectory = join(parent, basename(configuredWorkDirectory));
  hardlinkTree(configuredWorkDirectory, workDirectory);
  return workDirectory;
}

function firstRawPath(workDirectory) {
  const manifest = JSON.parse(readFileSync(join(workDirectory, 'inputs', 'input-manifest.json'), 'utf8'));
  const pose = manifest.uniquePoses[0];
  return {
    path: join(workDirectory, 'outputs', manifest.experimentId, `${pose.poseId}--${manifest.model.id}--image.png`),
    poseId: pose.poseId,
  };
}

function replaceHardlinkedFile(path, bytes) {
  unlinkSync(path);
  writeFileSync(path, bytes, { mode: 0o600 });
}

async function runExpectedHardGate(workDirectory, outputDirectory) {
  let caught;
  try {
    await postprocessHumanoidTemplate({ workDirectory, outputDirectory });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.message).toMatch(/hard gates failed/);
  const manifest = JSON.parse(readFileSync(join(outputDirectory, 'postprocess-manifest.json'), 'utf8'));
  return {
    manifest,
    hashes: readFileSync(join(outputDirectory, 'hashes.sha256')),
    manifestBytes: readFileSync(join(outputDirectory, 'postprocess-manifest.json')),
  };
}

function runExpectedHardGateWithPathSwap(workDirectory, outputDirectory, rawPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      postprocessScript,
      `--work-dir=${workDirectory}`,
      `--output-dir=${outputDirectory}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    let swapped = false;
    const poll = setInterval(() => {
      if (!swapped && existsSync(outputDirectory)) {
        try {
          replaceHardlinkedFile(rawPath, Buffer.from('path changed after trusted snapshot'));
          swapped = true;
        } catch (error) {
          clearInterval(poll);
          child.kill('SIGTERM');
          reject(error);
        }
      }
    }, 1);
    child.on('error', (error) => {
      clearInterval(poll);
      reject(error);
    });
    child.on('close', (code) => {
      clearInterval(poll);
      try {
        expect(swapped).toBe(true);
        expect(code).toBe(1);
        expect(Buffer.concat(stderr).toString('utf8')).toMatch(/hard gates failed/);
        resolve({
          manifest: JSON.parse(readFileSync(join(outputDirectory, 'postprocess-manifest.json'), 'utf8')),
          hashes: readFileSync(join(outputDirectory, 'hashes.sha256')),
          manifestBytes: readFileSync(join(outputDirectory, 'postprocess-manifest.json')),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describeFullArtifact('humanoid V4 full sealed artifact E2E', () => {
  it('accepts only the exact state/manifest seals and snapshots all 94 raws plus 98 slots', () => {
    const verified = verifyHumanoidPostprocessInputs({ workDirectory: configuredWorkDirectory });
    expect(verified.stateSha256).toBe(HUMANOID_V4_TRUSTED_SEAL.executionStateSha256);
    expect(verified.manifestSha256).toBe(HUMANOID_V4_TRUSTED_SEAL.inputManifestSha256);
    expect(verified.verified).toHaveLength(94);
    expect(verified.manifest.frameSlots).toHaveLength(98);
    expect(verified.aliasPoseIds).toHaveLength(4);
    expect(verified.verified.every((entry) => sha256(entry.sourceBytes) === entry.source.contentSha256)).toBe(true);
    expect(verified.verified.every((entry) => sha256(entry.rawBytes) === entry.raw.contentSha256)).toBe(true);
  });

  it('rejects a tampered raw even while the exact trusted state is intact', () => {
    const workDirectory = cloneFullArtifact();
    const raw = firstRawPath(workDirectory);
    const changed = Buffer.concat([readFileSync(raw.path), Buffer.from([0])]);
    replaceHardlinkedFile(raw.path, changed);
    expect(() => verifyHumanoidPostprocessInputs({ workDirectory })).toThrow(/raw bytes differ from execution state/);
  });

  it('rejects a tampered raw maliciously re-sealed into a rewritten state', () => {
    const workDirectory = cloneFullArtifact();
    const raw = firstRawPath(workDirectory);
    const changed = Buffer.concat([readFileSync(raw.path), Buffer.from([0])]);
    replaceHardlinkedFile(raw.path, changed);
    const statePath = join(workDirectory, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.slots[raw.poseId].artifacts.image.contentSha256 = sha256(changed);
    state.slots[raw.poseId].artifacts.image.sizeBytes = changed.byteLength;
    replaceHardlinkedFile(statePath, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
    expect(() => verifyHumanoidPostprocessInputs({ workDirectory })).toThrow(/execution state SHA-256 is not the exact trusted V4 state/);
  });

  it('rejects a byte-changed manifest and a raw symlink escape', () => {
    const manifestClone = cloneFullArtifact();
    const manifestPath = join(manifestClone, 'inputs', 'input-manifest.json');
    replaceHardlinkedFile(manifestPath, Buffer.concat([readFileSync(manifestPath), Buffer.from(' ')]));
    expect(() => verifyHumanoidPostprocessInputs({ workDirectory: manifestClone })).toThrow(/input manifest SHA-256 is not the exact trusted V4 manifest/);

    const symlinkClone = cloneFullArtifact();
    const raw = firstRawPath(symlinkClone);
    unlinkSync(raw.path);
    symlinkSync(firstRawPath(configuredWorkDirectory).path, raw.path);
    expect(() => verifyHumanoidPostprocessInputs({ workDirectory: symlinkClone })).toThrow(/symbolic link/);
  });

  it('survives a post-verification path swap, is repeatable, keeps aliases identical, and reports hard gates honestly', async () => {
    const outputParent = temporaryDirectory('insert-player-humanoid-v4-e2e-output-');
    const baselineOutput = join(outputParent, 'baseline');
    const baseline = await runExpectedHardGate(configuredWorkDirectory, baselineOutput);

    const swappedWorkDirectory = cloneFullArtifact();
    const swappedRaw = firstRawPath(swappedWorkDirectory);
    const originalRawHash = sha256(readFileSync(swappedRaw.path));
    const swappedOutput = join(outputParent, 'path-swapped');
    const swapped = await runExpectedHardGateWithPathSwap(swappedWorkDirectory, swappedOutput, swappedRaw.path);

    expect(swapped.hashes.equals(baseline.hashes)).toBe(true);
    expect(swapped.manifestBytes.equals(baseline.manifestBytes)).toBe(true);
    expect(sha256(readFileSync(join(swappedOutput, 'poses', 'raw', `${swapped.manifest.poses[0].poseId}.png`)))).toBe(originalRawHash);
    expect(baseline.manifest.status).toBe('hard_gate_failed');
    expect(baseline.manifest.counts.hardFailures).toBeGreaterThan(0);
    expect(baseline.manifest.hardFailures).toHaveLength(baseline.manifest.counts.hardFailures);
    expect(baseline.manifest.counts.knownVisualReviewFindings).toBe(31);
    expect(baseline.manifest.semanticReview).toMatchObject({
      status: 'required',
      scope: 'all_frame_slots',
      automatedApproval: false,
      requiredFrameSlots: 98,
    });
    expect(baseline.manifest.source).toMatchObject({
      inputManifestSha256: HUMANOID_V4_TRUSTED_SEAL.inputManifestSha256,
      executionStateSha256: HUMANOID_V4_TRUSTED_SEAL.executionStateSha256,
      trustedArtifactProvenance: {
        encryptedArtifactSha256: HUMANOID_V4_TRUSTED_SEAL.encryptedArtifactSha256,
        githubActionsRunId: HUMANOID_V4_TRUSTED_SEAL.githubActionsRunId,
        verification: 'out_of_band_provenance',
      },
    });

    for (const alias of baseline.manifest.aliases) {
      const frames = baseline.manifest.frameSlots.filter((frame) => frame.poseId === alias.poseId);
      expect(frames).toHaveLength(2);
      for (const kind of ['raw', 'unregisteredRgba', 'registeredRgba', 'chromaRgb24']) {
        const left = readFileSync(join(baselineOutput, frames[0].outputs[kind].path));
        const right = readFileSync(join(baselineOutput, frames[1].outputs[kind].path));
        expect(left.equals(right)).toBe(true);
        expect(sha256(left)).toBe(alias.hashes[kind]);
      }
    }
  }, 1_800_000);
});

describeCombinedArtifact('humanoid sealed V4 plus reviewed V5 replacement artifact E2E', () => {
  it('snapshots exactly 24 V5 replacements plus 70 retained V4 raws with exact lineage', () => {
    const replacementSealRecord = loadHumanoidV5ReplacementSeal({
      sealPath: HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.path,
      expectedSealSha256: HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.contentSha256,
    });
    const verified = verifyHumanoidCombinedPostprocessInputs({
      workDirectory: configuredWorkDirectory,
      replacementWorkDirectory: configuredReplacementWorkDirectory,
    });
    expect(verified.verified).toHaveLength(94);
    expect(verified.verified.filter((entry) => entry.rawProvenance.source === 'reviewed_v5_replacement')).toHaveLength(24);
    expect(verified.verified.filter((entry) => entry.rawProvenance.source === 'sealed_v4')).toHaveLength(70);
    expect(verified.verified.filter((entry) => entry.rawProvenance.generationMode === 'canary')).toHaveLength(5);
    expect(verified.verified.filter((entry) => entry.rawProvenance.generationMode === 'repair')).toHaveLength(19);
    expect(verified.knownVisualReviewFindings).toHaveLength(3);
    expect(verified.supersededVisualReviewFindings).toHaveLength(28);
    expect(verified.combination.replacement).toMatchObject({
      executionStateSha256: replacementSealRecord.seal.executionStateSha256,
      inputManifestSha256: replacementSealRecord.seal.inputManifestSha256,
      repairManifestSha256: replacementSealRecord.seal.repairManifestSha256,
      trustSealSha256: HUMANOID_V5_REPLACEMENT_TRUSTED_SEAL.contentSha256,
    });
    expect(verified.verified.every((entry) => sha256(entry.rawBytes) === entry.raw.contentSha256)).toBe(true);
  });
});
