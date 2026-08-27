import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pollJob,
  submitBakeoffSlot,
  uploadBakeoffSource,
  verifyBakeoffSource,
} from './arcade-side-bakeoff.mjs';
import { validateManifest } from './seed-arcade-roster.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_MANIFEST_PATH = join(root, 'arcade/roster-2026.json');
const DEFAULT_SOURCE_DIR = join(root, '.arcade-sources');
const DEFAULT_OUTPUT_ROOT = join(root, '.artifacts/arcade-xai-canonical-bundles');
const DEFAULT_STATE_ROOT = join(root, '.arcade-xai-canonical-bundle-states');
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const XAI_CANONICAL_BUNDLE_BASE_COMMIT = 'fca24ac39763b879eb6072c0cfb39ea098e5705d';
export const XAI_CANONICAL_BUNDLE_CONFIRMATION = 'GENERATE_XAI_CANONICAL_BUNDLE_PRIVATE_V1';
export const XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION = 'PRIVATE_ARTIFACTS_ONLY_HUMAN_REVIEW';
export const XAI_CANONICAL_BUNDLE_SOURCE_NAMES = Object.freeze(['side', 'upright', 'crouch']);
export const XAI_CANONICAL_BUNDLE_MODEL = Object.freeze({
  id: 'grok-imagine-image-2-edit',
  endpoint: 'xai/grok-imagine-image/v2.0/edit',
  provider: 'xai',
  backend: 'fal',
  catalogCostPerImage: 110000,
  auditedCostUsd: 0.11,
  maxCostPerOutputUsd: 0.12,
  maxBundleCostUsd: 0.36,
  params: Object.freeze({
    num_images: 1,
    aspect_ratio: 'auto',
    resolution: '2k',
    output_format: 'png',
    quality: 'medium',
  }),
});
export const XAI_CANONICAL_BUNDLE_CLEANUP = Object.freeze({
  ffmpegVersion: '5.1.9-0+deb12u1',
  filter: 'chromakey=0x00FF00:0.20:0.08,format=rgba',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function nowIso() {
  return new Date().toISOString();
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value ?? {}).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} keys are not sealed.`);
  }
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid.`);
  return value;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function acquireExclusiveBundleLocks(statePath, outputDirectory) {
  const nonce = randomUUID();
  const lockPaths = [...new Set([`${statePath}.lock`, `${outputDirectory}.lock`])].sort();
  const owned = [];
  try {
    for (const lockPath of lockPaths) {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      let descriptor;
      try {
        descriptor = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new Error(`Canonical bundle lock exists and requires manual reconciliation: ${lockPath}.`);
        }
        throw error;
      }
      owned.push({ lockPath, descriptor, nonce });
      const record = {
        schemaVersion: 1,
        nonce,
        pid: process.pid,
        statePath,
        outputDirectory,
        acquiredAt: nowIso(),
      };
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(descriptor);
    }
  } catch (error) {
    releaseExclusiveBundleLocks(owned);
    throw error;
  }
  return owned;
}

function releaseExclusiveBundleLocks(owned) {
  let releaseError = null;
  for (const lock of [...owned].reverse()) {
    try {
      closeSync(lock.descriptor);
      const current = JSON.parse(readFileSync(lock.lockPath, 'utf8'));
      if (current.nonce !== lock.nonce) {
        throw new Error(`Canonical bundle lock ownership changed: ${lock.lockPath}.`);
      }
      unlinkSync(lock.lockPath);
    } catch (error) {
      releaseError ??= error;
    }
  }
  if (releaseError) throw releaseError;
}

function writeBytesAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function resolvePrivateInput(baseDirectory, path, label) {
  requireString(path, `${label}.path`);
  if (path.startsWith('/') || path.includes('\\')) throw new Error(`${label}.path must be relative.`);
  const resolved = resolve(baseDirectory, path);
  const prefix = `${resolve(baseDirectory)}${sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`${label}.path escapes the private manifest directory.`);
  return resolved;
}

export function inspectPng(bytes, label = 'PNG') {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.byteLength < 24
    || bytes.byteLength > MAX_PNG_BYTES
    || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`${label} is not a bounded PNG.`);
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`${label} lacks a PNG IHDR.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw new Error(`${label} dimensions are outside the sealed bounds.`);
  }
  return { width, height, sizeBytes: bytes.byteLength, contentSha256: sha256(bytes) };
}

function readApprovedReference(reference, baseDirectory, label) {
  exactKeys(reference, [
    'id', 'path', 'contentSha256', 'sizeBytes', 'width', 'height', 'approvalEvidence',
  ], label);
  requireString(reference.id, `${label}.id`, /^[a-z0-9][a-z0-9-]{2,95}$/);
  requireString(reference.contentSha256, `${label}.contentSha256`, /^[a-f0-9]{64}$/);
  requireInteger(reference.sizeBytes, `${label}.sizeBytes`, 24);
  requireInteger(reference.width, `${label}.width`, 64);
  requireInteger(reference.height, `${label}.height`, 64);
  exactKeys(reference.approvalEvidence, [
    'path', 'contentSha256', 'selector', 'expectedValue',
  ], `${label}.approvalEvidence`);
  requireString(reference.approvalEvidence.contentSha256, `${label}.approvalEvidence.contentSha256`, /^[a-f0-9]{64}$/);
  requireString(reference.approvalEvidence.selector, `${label}.approvalEvidence.selector`, /^[A-Za-z0-9_.-]+$/);
  const affirmativeDecision = reference.approvalEvidence.expectedValue === true
    || reference.approvalEvidence.expectedValue === 'approved'
    || (
      typeof reference.approvalEvidence.expectedValue === 'string'
      && /^[a-f0-9]{64}$/.test(reference.approvalEvidence.expectedValue)
    );
  if (!affirmativeDecision) throw new Error(`${label} approval evidence is not an affirmative sealed decision.`);

  const path = resolvePrivateInput(baseDirectory, reference.path, label);
  const evidencePath = resolvePrivateInput(
    baseDirectory,
    reference.approvalEvidence.path,
    `${label}.approvalEvidence`,
  );
  if (!existsSync(path) || !existsSync(evidencePath)) throw new Error(`${label} private artifact or approval evidence is missing.`);
  const bytes = readFileSync(path);
  const inspected = inspectPng(bytes, label);
  for (const key of ['contentSha256', 'sizeBytes', 'width', 'height']) {
    if (inspected[key] !== reference[key]) throw new Error(`${label} ${key} does not match its sealed descriptor.`);
  }
  const evidenceBytes = readFileSync(evidencePath);
  if (sha256(evidenceBytes) !== reference.approvalEvidence.contentSha256) {
    throw new Error(`${label} approval evidence hash mismatch.`);
  }
  let evidence;
  try {
    evidence = JSON.parse(evidenceBytes.toString('utf8'));
  } catch {
    throw new Error(`${label} approval evidence is not JSON.`);
  }
  let selected = evidence;
  for (const key of reference.approvalEvidence.selector.split('.')) {
    if (!selected || typeof selected !== 'object' || !Object.hasOwn(selected, key)) {
      throw new Error(`${label} approval evidence selector does not exist.`);
    }
    selected = selected[key];
  }
  if (canonicalJson(selected) !== canonicalJson(reference.approvalEvidence.expectedValue)) {
    throw new Error(`${label} approval evidence selector did not match.`);
  }
  return { ...reference, absolutePath: path, bytes };
}

export function loadXaiCanonicalPoseManifest(path, expectedSha256) {
  requireString(path, 'pose manifest path');
  requireString(expectedSha256, 'pose manifest SHA-256', /^[a-f0-9]{64}$/);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedSha256) throw new Error('Pose manifest SHA-256 mismatch.');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Pose manifest is not JSON.');
  }
  exactKeys(manifest, [
    'schemaVersion', 'manifestId', 'status', 'referenceOrder', 'sources',
  ], 'pose manifest');
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported pose manifest schema.');
  requireString(manifest.manifestId, 'pose manifest id', /^arcade-xai-canonical-pose-bundle-[a-z0-9-]+-v[0-9]+$/);
  if (manifest.status !== 'human_reviewed') throw new Error('Pose manifest is not human reviewed.');
  if (canonicalJson(manifest.referenceOrder) !== canonicalJson([
    'pose_composition_master',
    'canonical_rendering_master',
    'identity_photo',
  ])) {
    throw new Error('Pose manifest reference order changed.');
  }
  exactKeys(manifest.sources, XAI_CANONICAL_BUNDLE_SOURCE_NAMES, 'pose manifest sources');
  const baseDirectory = dirname(resolve(path));
  const sources = {};
  for (const sourceName of XAI_CANONICAL_BUNDLE_SOURCE_NAMES) {
    const source = manifest.sources[sourceName];
    exactKeys(source, ['pose', 'rendering'], `pose manifest ${sourceName}`);
    const pose = readApprovedReference(source.pose, baseDirectory, `${sourceName} pose`);
    const rendering = readApprovedReference(source.rendering, baseDirectory, `${sourceName} rendering`);
    if (pose.contentSha256 === rendering.contentSha256) {
      throw new Error(`${sourceName} pose and rendering masters must be distinct reviewed assets.`);
    }
    sources[sourceName] = { pose, rendering };
  }
  return { manifest, manifestSha256: expectedSha256, sources };
}

function sourcePoseInstruction(sourceName) {
  if (sourceName === 'side') {
    return 'a neutral full-body combat guard in a clear 3/4 side presentation facing right, with both feet fully visible and stable';
  }
  if (sourceName === 'upright') {
    return 'an upright neutral full-body ready stance in 3/4 view facing right, balanced and suitable as the standing canonical anchor';
  }
  if (sourceName === 'crouch') {
    return 'a deep but anatomically balanced crouching guard in 3/4 view facing right, with both feet and the complete silhouette visible';
  }
  throw new Error(`Unsupported canonical source: ${String(sourceName)}.`);
}

function fighterRequirements(fighter, sourceName) {
  const original = fighter.referencePrompt?.trim() ?? '';
  if (original.length < 180) throw new Error(`Roster prompt is incomplete for ${fighter.slug}.`);
  const replaced = original.replace(
    /Show the complete figure head-to-toe in [^,]+,\s*3\/4 view facing right,/i,
    `Show the complete figure head-to-toe in ${sourcePoseInstruction(sourceName)},`,
  );
  if (replaced === original) throw new Error(`Roster prompt pose contract is unsupported for ${fighter.slug}.`);
  return replaced;
}

export function buildXaiCanonicalBundlePrompt(fighter, sourceName) {
  return [
    'REFERENCE ROLES — KEEP ALL THREE STRICTLY SEPARATE:',
    'IMAGE 1 is the POSE AND COMPOSITION MASTER only. Match its body pose, facing direction, balance, full-body framing, camera distance, and silhouette placement. Never copy its identity, face, hair, physique, clothes, colors, logos, or accessories.',
    'IMAGE 2 is the CANONICAL RENDERING MASTER only. Match its grounded premium fighting-game rendering language, natural adult proportions, material detail, controlled lighting, crisp edge treatment, and green-screen presentation. Never copy its identity, face, hair, clothes, colors, logos, or accessories.',
    'IMAGE 3 is the REAL IDENTITY AND PHYSIQUE ANCHOR only. Preserve this person\'s facial geometry, hair, skin tone, apparent age, distinguishing features, and natural body build. Never copy the portrait crop, camera, background, or photographic rendering.',
    '',
    'TARGET SOURCE:',
    `Produce exactly one ${sourceName.toUpperCase()} canonical source: ${sourcePoseInstruction(sourceName)}.`,
    '',
    'IDENTITY, ANATOMY, AND CONSISTENCY:',
    'Replace every person in IMAGE 1 and IMAGE 2 with the person from IMAGE 3. Never blend faces or identities. Keep normal adult anatomy, a natural head scale, complete hands and feet, and coherent joints. The result must be immediately recognizable as IMAGE 3 while using only the assigned pose and rendering roles from the other references.',
    '',
    'ROSTER REQUIREMENTS:',
    fighterRequirements(fighter, sourceName),
    '',
    'OUTPUT CONTRACT:',
    'Return exactly one full-body character image, not a sprite sheet, sequence, collage, comparison, or contact sheet. Background must be pure bright green (#00FF00), flat and uniform, with no shadow, floor, gradient, text, watermark, logo, badge, emblem, brand-like symbol, prop, or border.',
    '',
    'FINAL PRIORITY ORDER:',
    '1) Pose and composition from IMAGE 1. 2) Rendering language only from IMAGE 2. 3) Identity and physique from IMAGE 3. 4) Wardrobe and character details from the written roster requirements. Never let one reference overwrite another reference\'s assigned role.',
  ].join('\n');
}

export function buildXaiCanonicalBundlePayload({
  fighter,
  sourceName,
  poseAssetHash,
  renderingAssetHash,
  identityAssetHash,
}) {
  for (const [label, hash] of [
    ['pose', poseAssetHash],
    ['rendering', renderingAssetHash],
    ['identity', identityAssetHash],
  ]) {
    requireString(hash, `${label} PixCLI asset hash`, /^[a-f0-9]{32}$/);
  }
  if (new Set([poseAssetHash, renderingAssetHash, identityAssetHash]).size !== 3) {
    throw new Error(`${sourceName} must use three distinct PixCLI reference assets.`);
  }
  const marker = `ip-canonical-v1-${fighter.slug}-${sourceName}`;
  if (marker.length > 60) throw new Error(`PixCLI marker exceeds 60 characters: ${marker}.`);
  return {
    prompt: buildXaiCanonicalBundlePrompt(fighter, sourceName),
    model: XAI_CANONICAL_BUNDLE_MODEL.id,
    image: [poseAssetHash, renderingAssetHash, identityAssetHash],
    params: { ...XAI_CANONICAL_BUNDLE_MODEL.params },
    enrich_prompt: false,
    search: false,
    output_format: 'url',
    publish: false,
    publish_name: marker,
  };
}

export async function preflightXaiCanonicalBundleModel(options = {}) {
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const response = await (options.fetchImpl ?? fetch)(`${apiBase}/api/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'insert-player-xai-canonical-bundle/1.0',
    },
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`PixCLI model preflight returned non-JSON HTTP ${response.status}.`);
  }
  if (!response.ok) throw new Error(`PixCLI model preflight failed with HTTP ${response.status}.`);
  const models = Array.isArray(body) ? body : body?.models;
  if (!Array.isArray(models)) throw new Error('PixCLI model preflight returned an unsupported catalog.');
  const matches = models.filter((entry) => entry?.id === XAI_CANONICAL_BUNDLE_MODEL.id);
  if (matches.length !== 1) throw new Error('Pinned PixCLI model is missing or ambiguous.');
  const model = matches[0];
  if (
    model.provider !== XAI_CANONICAL_BUNDLE_MODEL.provider
    || model.backend !== XAI_CANONICAL_BUNDLE_MODEL.backend
    || model.cost_per_image !== XAI_CANONICAL_BUNDLE_MODEL.catalogCostPerImage
    || model.advanced_mode !== true
    || !Array.isArray(model.capabilities)
    || !model.capabilities.includes('edit')
    || !model.capabilities.includes('image-to-image')
  ) {
    throw new Error('Pinned PixCLI model, capabilities, backend, or audited $0.11 price changed.');
  }
  return { model, catalogSha256: sha256(text) };
}

function defaultCommand(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    throw new Error(`${basename(binary)} failed: ${(result.error?.message ?? result.stderr ?? '').trim().slice(-1000)}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function verifyCanonicalCleanupToolchain(options = {}) {
  const runCommand = options.runCommand ?? defaultCommand;
  const ffmpegBinary = options.ffmpegBinary ?? 'ffmpeg';
  const result = runCommand(ffmpegBinary, ['-version']);
  const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine.startsWith(`ffmpeg version ${XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion} `)) {
    throw new Error('ffmpeg does not match the sealed canonical-cleanup toolchain.');
  }
  return firstLine;
}

function runCanonicalCleanup(rawPath, cleanPath, options = {}) {
  const temporary = `${cleanPath}.writing-${process.pid}.png`;
  (options.runCommand ?? defaultCommand)(options.ffmpegBinary ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-threads', '1', '-filter_threads', '1', '-i', rawPath,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', XAI_CANONICAL_BUNDLE_CLEANUP.filter,
    '-frames:v', '1', '-compression_level', '9', temporary,
  ]);
  if (!existsSync(temporary)) throw new Error('ffmpeg did not produce the canonical clean PNG.');
  const bytes = readFileSync(temporary);
  inspectPng(bytes, 'canonical clean output');
  chmodSync(temporary, 0o600);
  renameSync(temporary, cleanPath);
  chmodSync(cleanPath, 0o600);
  return { ...inspectPng(bytes, 'canonical clean output'), path: cleanPath };
}

function createContactSheet(sourceArtifacts, outputPath, options = {}) {
  const temporary = `${outputPath}.writing-${process.pid}.png`;
  const inputArgs = [];
  for (const name of XAI_CANONICAL_BUNDLE_SOURCE_NAMES) {
    inputArgs.push('-i', sourceArtifacts[name].raw.absolutePath, '-i', sourceArtifacts[name].clean.absolutePath);
  }
  const filters = [];
  for (let index = 0; index < 6; index += 1) {
    filters.push(`[${index}:v]scale=384:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=384:512:(ow-iw)/2:(oh-ih)/2:color=0x202226,format=rgba[t${index}]`);
  }
  filters.push('[t0][t2][t4][t1][t3][t5]xstack=inputs=6:layout=0_0|384_0|768_0|0_512|384_512|768_512:fill=0x202226[review]');
  (options.runCommand ?? defaultCommand)(options.ffmpegBinary ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1',
    ...inputArgs,
    '-filter_complex', filters.join(';'), '-map', '[review]', '-frames:v', '1', '-compression_level', '9', temporary,
  ]);
  if (!existsSync(temporary)) throw new Error('ffmpeg did not produce the contact sheet.');
  const bytes = readFileSync(temporary);
  const inspected = inspectPng(bytes, 'canonical contact sheet');
  if (inspected.width !== 1152 || inspected.height !== 1024) {
    throw new Error('Canonical contact sheet dimensions changed.');
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, outputPath);
  chmodSync(outputPath, 0o600);
  return { ...inspected, path: outputPath };
}

function stateResumeAction(slot) {
  if (!slot) return 'submit';
  if (slot.status === 'submitted' || slot.status === 'processing') return 'poll';
  if (slot.status === 'provider_completed') return 'clean';
  if (slot.status === 'completed') return 'verify';
  if (slot.status === 'submitting' || slot.status === 'submission_outcome_unknown') return 'block';
  if (slot.status === 'failed' || slot.status === 'submission_rejected') return 'terminal';
  throw new Error(`Unknown canonical source state: ${String(slot.status)}.`);
}

function readState(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function verifyStoredArtifact(artifact, outputDirectory, label) {
  const absolutePath = resolve(outputDirectory, artifact?.path ?? '');
  if (!absolutePath.startsWith(`${resolve(outputDirectory)}${sep}`) || !existsSync(absolutePath)) {
    throw new Error(`${label} local artifact is missing.`);
  }
  const inspected = inspectPng(readFileSync(absolutePath), label);
  for (const key of ['contentSha256', 'sizeBytes', 'width', 'height']) {
    if (artifact[key] !== inspected[key]) throw new Error(`${label} local artifact hash or shape changed.`);
  }
  return { ...artifact, absolutePath };
}

async function parseResponseJson(response, label) {
  const text = await response.text();
  try {
    return { body: text ? JSON.parse(text) : {}, text };
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status} (${sha256(text)}).`);
  }
}

function auditKind(asset) {
  const kind = asset?.metadata?.artifact_kind;
  if (kind === 'provider_request' || kind === 'provider_response') return kind;
  if (String(asset?.mime_type ?? '').startsWith('image/')) return 'image';
  return null;
}

async function downloadAuditAsset(asset, path, headers, fetchImpl) {
  requireString(asset?.hash, 'PixCLI audit asset hash', /^[a-f0-9]{32}$/);
  requireString(asset?.url, 'PixCLI audit asset URL', /^https:\/\//);
  requireString(asset?.metadata?.content_sha256, 'PixCLI audit content SHA-256', /^[a-f0-9]{64}$/);
  const response = await fetchImpl(asset.url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`PixCLI audit artifact download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (asset.metadata.content_sha256 !== actual) {
    throw new Error(`PixCLI audit artifact hash mismatch for ${basename(path)}.`);
  }
  if (asset.mime_type === 'application/json') JSON.parse(bytes.toString('utf8'));
  writeBytesAtomic(path, bytes);
  return {
    contentSha256: actual,
    sizeBytes: bytes.byteLength,
    mimeType: asset.mime_type,
    pixcliAssetHash: asset.hash,
    providerRequestId: asset?.metadata?.provider_request_id ?? null,
  };
}

async function archiveCompletedSource(options, slot, job, payload) {
  if (job.status !== 'completed') throw new Error(`${slot.sourceName} did not complete without fallback.`);
  if (
    typeof job.cost !== 'number'
    || !Number.isFinite(job.cost)
    || Math.abs(job.cost - XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd) > 1e-9
  ) {
    throw new Error(`${slot.sourceName} provider cost changed from the audited $0.11.`);
  }
  const response = await options.fetchImpl(
    `${options.apiBase}/api/v1/jobs/${encodeURIComponent(slot.pixcliJobId)}/canva`,
    { headers: options.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  const { body: canva } = await parseResponseJson(response, 'PixCLI Canva audit');
  if (!response.ok) throw new Error(`PixCLI Canva audit failed with HTTP ${response.status}.`);
  if (sha256(canonicalJson(canva.input)) !== slot.requestSha256) {
    throw new Error(`${slot.sourceName} PixCLI input does not match the sealed request.`);
  }
  const providerRuns = Array.isArray(canva.provider_runs) ? canva.provider_runs : [];
  if (
    canva.job?.status !== 'completed'
    || canva.job?.job_id !== slot.pixcliJobId
    || typeof canva.job?.cost !== 'number'
    || !Number.isFinite(canva.job.cost)
    || Math.abs(canva.job.cost - XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd) > 1e-9
  ) {
    throw new Error(`${slot.sourceName} PixCLI audited job status, id, or $0.11 cost changed.`);
  }
  if (
    providerRuns.length !== 1
    || providerRuns[0]?.modelId !== XAI_CANONICAL_BUNDLE_MODEL.id
    || providerRuns[0]?.provider !== XAI_CANONICAL_BUNDLE_MODEL.backend
    || typeof providerRuns[0]?.requestId !== 'string'
    || !providerRuns[0].requestId
  ) {
    throw new Error(`${slot.sourceName} PixCLI provider run is missing or ambiguous.`);
  }
  const assets = Array.isArray(canva.assets) ? canva.assets : [];
  const grouped = Object.groupBy(assets, auditKind);
  for (const kind of ['provider_request', 'provider_response', 'image']) {
    if ((grouped[kind] ?? []).length !== 1) throw new Error(`${slot.sourceName} ${kind} output is missing or ambiguous.`);
  }
  const auditDirectory = join(options.outputDirectory, 'audit', slot.sourceName);
  mkdirSync(auditDirectory, { recursive: true, mode: 0o700 });
  const request = await downloadAuditAsset(
    grouped.provider_request[0],
    join(auditDirectory, 'provider_request.json'),
    options.headers,
    options.fetchImpl,
  );
  const providerResponse = await downloadAuditAsset(
    grouped.provider_response[0],
    join(auditDirectory, 'provider_response.json'),
    options.headers,
    options.fetchImpl,
  );
  const rawPath = join(options.outputDirectory, 'sources', `${slot.sourceName}_raw.png`);
  const rawDownload = await downloadAuditAsset(grouped.image[0], rawPath, options.headers, options.fetchImpl);
  const rawInspected = inspectPng(readFileSync(rawPath), `${slot.sourceName} raw output`);
  if (grouped.image[0].mime_type !== 'image/png') throw new Error(`${slot.sourceName} output is not PNG.`);
  return {
    raw: {
      ...rawDownload,
      ...rawInspected,
      path: relative(options.outputDirectory, rawPath),
    },
    audit: {
      providerRequest: { ...request, path: relative(options.outputDirectory, join(auditDirectory, 'provider_request.json')) },
      providerResponse: { ...providerResponse, path: relative(options.outputDirectory, join(auditDirectory, 'provider_response.json')) },
      providerRun: providerRuns[0],
      inputSha256: sha256(canonicalJson(payload)),
      costUsd: job.cost,
    },
  };
}

function referenceUploadKey(reference) {
  return `reference:${reference.contentSha256}`;
}

async function ensureUploadedReference(options, reference, state, saveState) {
  const key = referenceUploadKey(reference);
  const previous = state.uploads[key];
  if (previous) {
    if (
      previous.status !== 'uploaded'
      || previous.contentSha256 !== reference.contentSha256
      || !/^[a-f0-9]{32}$/.test(previous.pixcliAssetHash ?? '')
    ) {
      throw new Error(`Reference upload requires manual reconciliation: ${reference.id}.`);
    }
    return previous;
  }
  const fighter = { slug: reference.id, reference: { sourceSha256: reference.contentSha256 } };
  return uploadBakeoffSource({
    apiBase: options.apiBase,
    apiKey: options.apiKey,
    fighter,
    sourceBytes: reference.bytes,
    sourceSha256: reference.contentSha256,
    fetchImpl: options.fetchImpl,
    save: (upload) => {
      state.uploads[key] = { ...upload, id: reference.id, contentSha256: reference.contentSha256 };
      saveState();
    },
  });
}

function buildBundleMatrix(fighter, poseBundle) {
  return XAI_CANONICAL_BUNDLE_SOURCE_NAMES.map((sourceName) => {
    const source = poseBundle.sources[sourceName];
    const prompt = buildXaiCanonicalBundlePrompt(fighter, sourceName);
    return {
      sourceName,
      fighterSlug: fighter.slug,
      originalSha256: fighter.reference.sourceSha256,
      poseId: source.pose.id,
      poseSha256: source.pose.contentSha256,
      renderingId: source.rendering.id,
      renderingSha256: source.rendering.contentSha256,
      promptSha256: sha256(prompt),
      modelId: XAI_CANONICAL_BUNDLE_MODEL.id,
      params: XAI_CANONICAL_BUNDLE_MODEL.params,
    };
  });
}

function buildInitialState({ fighter, poseBundle, matrixSha256 }) {
  return {
    schemaVersion: 1,
    bundleId: `arcade-xai-canonical-bundle-${fighter.slug}-v1`,
    fighterSlug: fighter.slug,
    fighterName: fighter.name,
    originalSha256: fighter.reference.sourceSha256,
    poseManifestId: poseBundle.manifest.manifestId,
    poseManifestSha256: poseBundle.manifestSha256,
    matrixSha256,
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    policy: {
      expectedPaidCalls: 3,
      maximumPaidCalls: 3,
      automaticRetries: 0,
      fallback: 'none',
      promptEnrichment: false,
      catalogCostPerOutputUsd: 0.11,
      maximumCostPerOutputUsd: 0.12,
      maximumBundleCostUsd: 0.36,
      outputVisibility: 'private_local',
      import: false,
      activation: false,
      humanReviewRequired: true,
    },
    uploads: {},
    slots: {},
  };
}

function buildDescriptor(state, matrix, artifacts, contactSheet, outputDirectory) {
  const portableArtifact = (artifact) => {
    const { absolutePath: _absolutePath, ...portable } = artifact;
    return portable;
  };
  const descriptor = {
    schemaVersion: 1,
    descriptorType: 'arcade_xai_canonical_bundle_review',
    bundleId: state.bundleId,
    status: 'awaiting_human_review',
    baseCommit: XAI_CANONICAL_BUNDLE_BASE_COMMIT,
    fighter: {
      slug: state.fighterSlug,
      name: state.fighterName,
      originalSha256: state.originalSha256,
    },
    poseManifest: {
      id: state.poseManifestId,
      contentSha256: state.poseManifestSha256,
    },
    provider: {
      modelId: XAI_CANONICAL_BUNDLE_MODEL.id,
      endpoint: XAI_CANONICAL_BUNDLE_MODEL.endpoint,
      provider: XAI_CANONICAL_BUNDLE_MODEL.provider,
      backend: XAI_CANONICAL_BUNDLE_MODEL.backend,
      auditedCostPerOutputUsd: XAI_CANONICAL_BUNDLE_MODEL.auditedCostUsd,
      maximumCostPerOutputUsd: XAI_CANONICAL_BUNDLE_MODEL.maxCostPerOutputUsd,
      maximumBundleCostUsd: XAI_CANONICAL_BUNDLE_MODEL.maxBundleCostUsd,
      paidCalls: 3,
      actualCostUsd: Number(Object.values(state.slots).reduce((sum, slot) => sum + slot.audit.costUsd, 0).toFixed(2)),
    },
    cleanup: {
      ffmpegVersion: XAI_CANONICAL_BUNDLE_CLEANUP.ffmpegVersion,
      filter: XAI_CANONICAL_BUNDLE_CLEANUP.filter,
    },
    policy: state.policy,
    sources: Object.fromEntries(XAI_CANONICAL_BUNDLE_SOURCE_NAMES.map((sourceName) => {
      const slot = state.slots[sourceName];
      const sealed = matrix.find((entry) => entry.sourceName === sourceName);
      return [sourceName, {
        references: {
          pose: { id: sealed.poseId, contentSha256: sealed.poseSha256 },
          rendering: { id: sealed.renderingId, contentSha256: sealed.renderingSha256 },
          identity: { contentSha256: state.originalSha256 },
        },
        promptSha256: slot.promptSha256,
        requestSha256: slot.requestSha256,
        pixcliJobId: slot.pixcliJobId,
        providerRequestId: slot.audit.providerRun.requestId,
        raw: portableArtifact(artifacts[sourceName].raw),
        clean: portableArtifact(artifacts[sourceName].clean),
      }];
    })),
    contactSheet: {
      path: relative(outputDirectory, contactSheet.path),
      contentSha256: contactSheet.contentSha256,
      sizeBytes: contactSheet.sizeBytes,
      width: contactSheet.width,
      height: contactSheet.height,
      layout: ['side_raw', 'upright_raw', 'crouch_raw', 'side_clean', 'upright_clean', 'crouch_clean'],
    },
  };
  return { ...descriptor, descriptorSha256: sha256(canonicalJson(descriptor)) };
}

export async function runXaiCanonicalBundle(options = {}) {
  if (options.confirmation !== XAI_CANONICAL_BUNDLE_CONFIRMATION) {
    throw new Error(`Paid execution requires confirmation ${XAI_CANONICAL_BUNDLE_CONFIRMATION}.`);
  }
  if (options.privateConfirmation !== XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION) {
    throw new Error(`Private-only execution requires confirmation ${XAI_CANONICAL_BUNDLE_PRIVATE_CONFIRMATION}.`);
  }
  if (Number(options.maxCostUsd) !== XAI_CANONICAL_BUNDLE_MODEL.maxBundleCostUsd) {
    throw new Error('Explicit --max-cost-usd=0.36 is required.');
  }
  const slug = requireString(options.slug, 'explicit roster slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const apiKey = options.apiKey ?? '';
  if (!apiKey) throw new Error('PIXCLI_API_KEY is required.');
  const apiBase = (options.apiBase ?? 'https://pixcli.hilo.cx').replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  validateManifest(manifest);
  const matches = manifest.fighters.filter((entry) => entry.slug === slug);
  if (matches.length !== 1) throw new Error(`Roster slug is missing or ambiguous: ${slug}.`);
  const fighter = matches[0];
  const poseBundle = loadXaiCanonicalPoseManifest(options.poseManifestPath, options.poseManifestSha256);
  const sourcePath = join(options.sourceDir ?? DEFAULT_SOURCE_DIR, `${slug}.png`);
  const original = verifyBakeoffSource(fighter, sourcePath);
  for (const sourceName of XAI_CANONICAL_BUNDLE_SOURCE_NAMES) {
    const referenceHashes = [
      poseBundle.sources[sourceName].pose.contentSha256,
      poseBundle.sources[sourceName].rendering.contentSha256,
      original.sourceSha256,
    ];
    if (new Set(referenceHashes).size !== 3) throw new Error(`${sourceName} references are not three distinct assets.`);
  }
  const matrix = buildBundleMatrix(fighter, poseBundle);
  const matrixSha256 = sha256(canonicalJson(matrix));
  const statePath = resolve(options.statePath ?? join(DEFAULT_STATE_ROOT, `${slug}.json`));
  const outputDirectory = resolve(options.outputDirectory ?? join(DEFAULT_OUTPUT_ROOT, slug));
  const locks = acquireExclusiveBundleLocks(statePath, outputDirectory);
  try {
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(join(outputDirectory, 'sources'), { recursive: true, mode: 0o700 });
    let state = readState(statePath) ?? buildInitialState({ fighter, poseBundle, matrixSha256 });
  const expected = buildInitialState({ fighter, poseBundle, matrixSha256 });
  for (const key of [
    'schemaVersion', 'bundleId', 'fighterSlug', 'originalSha256', 'poseManifestId',
    'poseManifestSha256', 'matrixSha256',
  ]) {
    if (state[key] !== expected[key]) throw new Error(`Existing canonical bundle state mismatch: ${key}.`);
  }
  if (canonicalJson(state.policy) !== canonicalJson(expected.policy)) {
    throw new Error('Existing canonical bundle state policy changed.');
  }
  const unknownSlots = Object.keys(state.slots ?? {}).filter((name) => !XAI_CANONICAL_BUNDLE_SOURCE_NAMES.includes(name));
  if (unknownSlots.length > 0) throw new Error('Existing canonical bundle state contains an unknown paid-call slot.');
  const saveState = () => {
    state.updatedAt = nowIso();
    writeJsonAtomic(statePath, state);
  };
  const saveSlot = (slot) => {
    state.slots[slot.sourceName] = slot;
    saveState();
  };
  saveState();

  const ffmpegVersion = verifyCanonicalCleanupToolchain(options);
  let preflight = null;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'insert-player-xai-canonical-bundle/1.0',
  };
  const identityReference = {
    id: `identity-${fighter.slug}`,
    contentSha256: original.sourceSha256,
    bytes: original.bytes,
  };

  for (const sealed of matrix) {
    const sourceName = sealed.sourceName;
    const references = poseBundle.sources[sourceName];
    const previous = state.slots[sourceName] ?? null;
    if (previous) {
      for (const key of [
        'sourceName', 'fighterSlug', 'originalSha256', 'poseSha256', 'renderingSha256',
        'promptSha256', 'modelId',
      ]) {
        if (previous[key] !== sealed[key]) throw new Error(`${sourceName} state invariant mismatch: ${key}.`);
      }
    }
    let action = stateResumeAction(previous);
    if (action === 'block') throw new Error(`${sourceName} has an ambiguous POST; automatic reconciliation is forbidden.`);
    if (action === 'terminal') throw new Error(`${sourceName} is terminal and the bundle cannot continue.`);
    if (action === 'submit') {
      preflight ??= await preflightXaiCanonicalBundleModel({ apiBase, apiKey, fetchImpl });
      state.lastCatalogPreflight = {
        modelId: XAI_CANONICAL_BUNDLE_MODEL.id,
        catalogSha256: preflight.catalogSha256,
        checkedAt: nowIso(),
      };
      saveState();
      const [poseUpload, renderingUpload, identityUpload] = await Promise.all([
        ensureUploadedReference({ apiBase, apiKey, fetchImpl }, references.pose, state, saveState),
        ensureUploadedReference({ apiBase, apiKey, fetchImpl }, references.rendering, state, saveState),
        ensureUploadedReference({ apiBase, apiKey, fetchImpl }, identityReference, state, saveState),
      ]);
      const payload = buildXaiCanonicalBundlePayload({
        fighter,
        sourceName,
        poseAssetHash: poseUpload.pixcliAssetHash,
        renderingAssetHash: renderingUpload.pixcliAssetHash,
        identityAssetHash: identityUpload.pixcliAssetHash,
      });
      const invariants = {
        ...sealed,
        slotKey: `${state.bundleId}:${sourceName}`,
        slug: fighter.slug,
        fighterName: fighter.name,
        sourceSha256: original.sourceSha256,
        providerEndpoint: XAI_CANONICAL_BUNDLE_MODEL.endpoint,
        requestSha256: sha256(canonicalJson(payload)),
      };
      const submitted = await submitBakeoffSlot({
        apiBase,
        apiKey,
        payload,
        slot: null,
        invariants,
        save: saveSlot,
        fetchImpl,
      });
      if (submitted.action === 'rejected') throw new Error(`${sourceName} PixCLI submission was rejected.`);
      action = 'poll';
    }
    let slot = state.slots[sourceName];
    const payload = (() => {
      const poseUpload = state.uploads[referenceUploadKey(references.pose)];
      const renderingUpload = state.uploads[referenceUploadKey(references.rendering)];
      const identityUpload = state.uploads[referenceUploadKey(identityReference)];
      if (![poseUpload, renderingUpload, identityUpload].every((entry) => entry?.status === 'uploaded')) {
        throw new Error(`${sourceName} upload state is incomplete.`);
      }
      return buildXaiCanonicalBundlePayload({
        fighter,
        sourceName,
        poseAssetHash: poseUpload.pixcliAssetHash,
        renderingAssetHash: renderingUpload.pixcliAssetHash,
        identityAssetHash: identityUpload.pixcliAssetHash,
      });
    })();
    if (slot.requestSha256 !== sha256(canonicalJson(payload))) throw new Error(`${sourceName} request hash changed.`);
    if (action === 'poll') {
      const job = await pollJob({
        apiBase,
        headers,
        saveSlot,
        fetchImpl,
        sleepImpl: options.sleepImpl,
        pollIntervalMs: options.pollIntervalMs,
        jobTimeoutMs: options.jobTimeoutMs,
      }, slot);
      if (job.status !== 'completed') {
        saveSlot({ ...slot, status: 'failed', providerStatus: job.status, providerError: job.error ?? null });
        throw new Error(`${sourceName} provider job did not complete cleanly.`);
      }
      const archived = await archiveCompletedSource({
        apiBase,
        headers,
        outputDirectory,
        fetchImpl,
      }, slot, job, payload);
      slot = { ...slot, ...archived, status: 'provider_completed', completedAt: nowIso() };
      saveSlot(slot);
      action = 'clean';
    }
    if (action === 'clean') {
      const raw = verifyStoredArtifact(slot.raw, outputDirectory, `${sourceName} raw`);
      const cleanPath = join(outputDirectory, 'sources', `${sourceName}.png`);
      const cleaned = runCanonicalCleanup(raw.absolutePath, cleanPath, options);
      slot = {
        ...slot,
        clean: { ...cleaned, path: relative(outputDirectory, cleanPath) },
        cleanupFfmpegVersion: ffmpegVersion,
        status: 'completed',
        updatedAt: nowIso(),
      };
      saveSlot(slot);
      action = 'verify';
    }
    if (action === 'verify') {
      verifyStoredArtifact(slot.raw, outputDirectory, `${sourceName} raw`);
      verifyStoredArtifact(slot.clean, outputDirectory, `${sourceName} clean`);
      if (slot.cleanupFfmpegVersion !== ffmpegVersion) throw new Error(`${sourceName} cleanup toolchain changed.`);
    }
  }

  const artifacts = Object.fromEntries(XAI_CANONICAL_BUNDLE_SOURCE_NAMES.map((sourceName) => {
    const slot = state.slots[sourceName];
    return [sourceName, {
      raw: verifyStoredArtifact(slot.raw, outputDirectory, `${sourceName} raw`),
      clean: verifyStoredArtifact(slot.clean, outputDirectory, `${sourceName} clean`),
    }];
  }));
  const contactSheet = createContactSheet(artifacts, join(outputDirectory, 'contact-sheet.png'), options);
  if (state.contactSheetSha256 && state.contactSheetSha256 !== contactSheet.contentSha256) {
    throw new Error('Canonical contact sheet changed on deterministic resume.');
  }
  const descriptor = buildDescriptor(state, matrix, artifacts, contactSheet, outputDirectory);
  writeJsonAtomic(join(outputDirectory, 'review-descriptor.json'), descriptor);
  state.status = 'awaiting_human_review';
  state.descriptorSha256 = descriptor.descriptorSha256;
  state.contactSheetSha256 = contactSheet.contentSha256;
  saveState();
  writeJsonAtomic(join(outputDirectory, 'generation-state.json'), state);
    return { state, descriptor, outputDirectory, statePath };
  } finally {
    releaseExclusiveBundleLocks(locks);
  }
}

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (!rawArgs.includes('--execute')) throw new Error('Paid execution requires --execute.');
  const slug = parseArg(rawArgs, '--slug');
  const result = await runXaiCanonicalBundle({
    confirmation: parseArg(rawArgs, '--confirm'),
    privateConfirmation: parseArg(rawArgs, '--confirm-private'),
    maxCostUsd: parseArg(rawArgs, '--max-cost-usd'),
    slug,
    apiKey: process.env.PIXCLI_API_KEY,
    apiBase: process.env.PIXCLI_BASE_URL,
    manifestPath: parseArg(rawArgs, '--manifest', DEFAULT_MANIFEST_PATH),
    sourceDir: parseArg(rawArgs, '--source-dir', DEFAULT_SOURCE_DIR),
    poseManifestPath: parseArg(rawArgs, '--pose-manifest'),
    poseManifestSha256: parseArg(rawArgs, '--pose-manifest-sha256'),
    statePath: parseArg(rawArgs, '--state', join(DEFAULT_STATE_ROOT, `${slug}.json`)),
    outputDirectory: parseArg(rawArgs, '--output-dir', join(DEFAULT_OUTPUT_ROOT, slug)),
  });
  console.log(`Canonical bundle ${result.state.bundleId} is awaiting human review.`);
  console.log(`Review descriptor: ${join(result.outputDirectory, 'review-descriptor.json')}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
