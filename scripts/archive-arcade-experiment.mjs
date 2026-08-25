import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CATALOG_PATH = join(root, 'arcade/experiment-archive-2026.json');
const WRANGLER_CLI = join(root, 'worker/node_modules/wrangler/bin/wrangler.js');
const WRANGLER_CONFIG = join(root, 'worker/wrangler.toml');
const R2_BUCKET = 'insert-player-assets';
const R2_JURISDICTION = 'eu';
const D1_DATABASE = 'insert-player-db';
const ARCHIVE_PREFIX = 'arcade-experiments/v1';
const CONFIRMATION = 'ARCHIVE_IMMUTABLE_ARCADE_EXPERIMENT_V1';
const TERMINAL_SLOT_STATUSES = new Set(['completed', 'failed', 'submission_rejected']);
const ARTIFACT_KINDS = new Set(['provider_request', 'provider_response', 'image', 'job_failure']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function parseArg(rawArgs, name, fallback = '') {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function assertSha256(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${label} is not a SHA-256 hash.`);
}

function assertSafeIdentifier(value, label) {
  if (!/^[a-z0-9][a-z0-9._:-]{2,160}$/i.test(value ?? '')) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function resolveInside(base, candidate, label) {
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(resolvedBase, candidate);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(`${resolvedBase}${sep}`)) {
    throw new Error(`${label} escapes the archive workspace.`);
  }
  return resolvedPath;
}

function extensionForArtifact(artifact) {
  if (artifact.mimeType === 'application/json') return 'json';
  if (artifact.mimeType === 'image/png') return 'png';
  if (artifact.mimeType === 'image/jpeg') return 'jpg';
  if (artifact.mimeType === 'image/webp') return 'webp';
  const extension = extname(artifact.path ?? '').slice(1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('Artifact extension is unsupported.');
  return extension;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlInteger(value, label) {
  if (value === null || value === undefined) return 'NULL';
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
  return String(value);
}

function loadCatalog(catalogPath) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.experiments)) {
    throw new Error('Arcade experiment archive catalog is invalid.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(catalog.repository ?? '')) {
    throw new Error('Arcade experiment archive repository is invalid.');
  }
  return catalog;
}

function artifactProviderRequestId(slot, artifact) {
  return artifact.providerRequestId
    ?? slot.providerRuns?.find((run) => typeof run?.requestId === 'string')?.requestId
    ?? null;
}

export function buildArcadeExperimentArchivePlan(options) {
  const rootDir = resolve(options.rootDir ?? root);
  const catalogPath = resolve(options.catalogPath ?? DEFAULT_CATALOG_PATH);
  const catalog = loadCatalog(catalogPath);
  const descriptor = catalog.experiments.find((entry) => entry.experimentId === options.experimentId);
  if (!descriptor) throw new Error(`Experiment is not sealed in the archive catalog: ${options.experimentId}.`);
  assertSafeIdentifier(descriptor.experimentId, 'Experiment ID');
  assertSha256(descriptor.stateSha256, 'Catalog state hash');
  if (!Number.isSafeInteger(descriptor.githubRunId) || descriptor.githubRunId <= 0) {
    throw new Error('Catalog GitHub run ID is invalid.');
  }

  const statePath = resolveInside(rootDir, descriptor.statePath, 'Experiment state path');
  if (!existsSync(statePath)) throw new Error(`Experiment state is missing: ${descriptor.statePath}.`);
  const stateBytes = readFileSync(statePath);
  const stateContentHash = sha256(stateBytes);
  if (stateContentHash !== descriptor.stateSha256) {
    throw new Error(`Experiment state hash mismatch: ${descriptor.experimentId}.`);
  }
  const state = JSON.parse(stateBytes.toString('utf8'));
  if (
    state.schemaVersion !== 2
    || state.experimentId !== descriptor.experimentId
    || state.status !== 'complete'
  ) {
    throw new Error(`Experiment state is not a completed schema-v2 run: ${descriptor.experimentId}.`);
  }
  assertSha256(state.matrixSha256, 'Experiment matrix hash');
  if (state.policy?.activation !== false || state.policy?.fallback !== 'none') {
    throw new Error(`Experiment policy is unsafe to archive: ${descriptor.experimentId}.`);
  }

  const slotEntries = Object.entries(state.slots ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (
    slotEntries.length < 1
    || state.policy?.expectedPaidCalls !== slotEntries.length
    || new Set(slotEntries.map(([slotKey]) => slotKey)).size !== slotEntries.length
  ) {
    throw new Error(`Experiment slot count does not match its sealed policy: ${descriptor.experimentId}.`);
  }

  const slots = slotEntries.map(([slotKey, slot]) => {
    assertSafeIdentifier(slotKey, 'Slot key');
    for (const [value, label] of [
      [slot.sourceSha256, 'Source hash'],
      [slot.promptSha256, 'Prompt hash'],
      [slot.requestSha256, 'Request hash'],
    ]) assertSha256(value, `${label} for ${slotKey}`);
    if (!TERMINAL_SLOT_STATUSES.has(slot.status)) {
      throw new Error(`Experiment slot is not terminal: ${slotKey}.`);
    }
    if (!slot.slug || !slot.fighterName || !slot.modelId || !slot.providerEndpoint) {
      throw new Error(`Experiment slot metadata is incomplete: ${slotKey}.`);
    }

    const artifacts = Object.entries(slot.artifacts ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, artifact]) => {
        if (!ARTIFACT_KINDS.has(kind)) throw new Error(`Unsupported artifact kind: ${slotKey}:${kind}.`);
        assertSha256(artifact.contentSha256, `Artifact hash for ${slotKey}:${kind}`);
        if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
          throw new Error(`Artifact size is invalid: ${slotKey}:${kind}.`);
        }
        const localPath = resolveInside(rootDir, artifact.path, `Artifact path for ${slotKey}:${kind}`);
        if (!existsSync(localPath)) throw new Error(`Artifact file is missing: ${artifact.path}.`);
        const bytes = readFileSync(localPath);
        if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.contentSha256) {
          throw new Error(`Artifact bytes do not match the sealed state: ${slotKey}:${kind}.`);
        }
        if (artifact.mimeType === 'application/json') JSON.parse(bytes.toString('utf8'));
        const slotPathHash = sha256(slotKey).slice(0, 20);
        return {
          kind,
          localPath,
          blobKey: `${ARCHIVE_PREFIX}/${descriptor.experimentId}/slots/${slotPathHash}/${kind}/${artifact.contentSha256}.${extensionForArtifact(artifact)}`,
          contentSha256: artifact.contentSha256,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          pixcliAssetHash: artifact.pixcliAssetHash ?? null,
          providerRequestId: artifactProviderRequestId(slot, artifact),
        };
      });
    if (!artifacts.some((artifact) => artifact.kind === 'provider_request')) {
      throw new Error(`Provider request audit is missing: ${slotKey}.`);
    }
    if (!artifacts.some((artifact) => artifact.kind === 'provider_response' || artifact.kind === 'job_failure')) {
      throw new Error(`Provider outcome audit is missing: ${slotKey}.`);
    }
    if (slot.status === 'completed' && !artifacts.some((artifact) => artifact.kind === 'image')) {
      throw new Error(`Completed slot image is missing: ${slotKey}.`);
    }
    return {
      slotKey,
      fighterSlug: slot.slug,
      fighterName: slot.fighterName,
      modelId: slot.modelId,
      providerEndpoint: slot.providerEndpoint,
      sourceSha256: slot.sourceSha256,
      promptSha256: slot.promptSha256,
      requestSha256: slot.requestSha256,
      status: slot.status,
      pixcliJobId: slot.pixcliJobId ?? null,
      providerRequestId: artifactProviderRequestId(slot, {}),
      pixcliCostEstimate: slot.pixcliCostEstimate ?? null,
      imageContentHash: artifacts.find((artifact) => artifact.kind === 'image')?.contentSha256 ?? null,
      completedAt: slot.completedAt ?? null,
      artifacts,
    };
  });

  const artifactCount = slots.reduce((total, slot) => total + slot.artifacts.length, 0);
  const indexDocument = slots.map((slot) => ({
    ...slot,
    artifacts: slot.artifacts.map(({ localPath: _localPath, ...artifact }) => artifact),
  }));
  const indexContentHash = sha256(canonicalJson(indexDocument));
  const stateBlobKey = `${ARCHIVE_PREFIX}/${descriptor.experimentId}/state/${stateContentHash}.json`;
  const manifest = {
    schemaVersion: 1,
    experimentId: descriptor.experimentId,
    repository: catalog.repository,
    githubRunId: descriptor.githubRunId,
    githubArtifactName: descriptor.githubArtifactName,
    sourceState: {
      blobKey: stateBlobKey,
      contentSha256: stateContentHash,
      sizeBytes: stateBytes.byteLength,
    },
    matrixSha256: state.matrixSha256,
    status: state.status,
    policy: state.policy,
    indexContentHash,
    sourceCreatedAt: state.createdAt ?? null,
    sourceCompletedAt: state.completedAt ?? null,
    slots: indexDocument,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestContentHash = sha256(manifestBytes);
  const manifestBlobKey = `${ARCHIVE_PREFIX}/${descriptor.experimentId}/manifest/${manifestContentHash}.json`;

  return {
    descriptor,
    repository: catalog.repository,
    state,
    statePath,
    stateBytes,
    stateBlobKey,
    stateContentHash,
    slots,
    artifactCount,
    indexContentHash,
    manifest,
    manifestBytes,
    manifestBlobKey,
    manifestContentHash,
  };
}

export function buildArcadeExperimentIndexSql(plan) {
  const experiment = [
    plan.state.experimentId,
    plan.state.schemaVersion,
    plan.state.matrixSha256,
    plan.state.status,
    JSON.stringify(plan.state.policy),
    plan.indexContentHash,
    plan.slots.length,
    plan.artifactCount,
    plan.stateBlobKey,
    plan.stateContentHash,
    plan.stateBytes.byteLength,
    plan.manifestBlobKey,
    plan.manifestContentHash,
    plan.manifestBytes.byteLength,
    plan.repository,
    plan.descriptor.githubRunId,
    plan.state.createdAt ?? null,
    plan.state.completedAt ?? null,
  ];
  const lines = [
    '-- Wrangler/D1 executes SQL-file statements as a managed batch; explicit transactions are unsupported.',
    `INSERT OR IGNORE INTO arcade_generation_experiments (`
      + 'id, schema_version, matrix_sha256, status, policy_json, index_content_hash, slot_count, artifact_count, '
      + 'state_blob_key, state_content_hash, state_size_bytes, manifest_blob_key, manifest_content_hash, '
      + 'manifest_size_bytes, github_repository, github_run_id, source_created_at, source_completed_at'
      + `) VALUES (${experiment.map((value, index) => (
        [1, 6, 7, 10, 13, 15].includes(index)
          ? sqlInteger(value, `Experiment integer ${index}`)
          : sqlString(value)
      )).join(', ')});`,
  ];
  for (const slot of plan.slots) {
    const values = [
      plan.state.experimentId,
      slot.slotKey,
      slot.fighterSlug,
      slot.fighterName,
      slot.modelId,
      slot.providerEndpoint,
      slot.sourceSha256,
      slot.promptSha256,
      slot.requestSha256,
      slot.status,
      slot.pixcliJobId,
      slot.providerRequestId,
      slot.pixcliCostEstimate,
      slot.imageContentHash,
      slot.completedAt,
    ];
    lines.push(
      `INSERT OR IGNORE INTO arcade_generation_experiment_slots (`
        + 'experiment_id, slot_key, fighter_slug, fighter_name, model_id, provider_endpoint, source_sha256, '
        + 'prompt_sha256, request_sha256, status, pixcli_job_id, provider_request_id, pixcli_cost_estimate, '
        + 'image_content_hash, completed_at'
        + `) SELECT ${values.map((value, index) => (
          index === 12 ? sqlInteger(value, `Slot cost for ${slot.slotKey}`) : sqlString(value)
        )).join(', ')} WHERE (`
        + `SELECT index_content_hash FROM arcade_generation_experiments WHERE id = ${sqlString(plan.state.experimentId)}`
        + `) = ${sqlString(plan.indexContentHash)};`,
    );
    for (const artifact of slot.artifacts) {
      const artifactValues = [
        plan.state.experimentId,
        slot.slotKey,
        artifact.kind,
        artifact.blobKey,
        artifact.contentSha256,
        artifact.mimeType,
        artifact.sizeBytes,
        artifact.pixcliAssetHash,
        artifact.providerRequestId,
      ];
      lines.push(
        `INSERT OR IGNORE INTO arcade_generation_experiment_artifacts (`
          + 'experiment_id, slot_key, artifact_kind, blob_key, content_sha256, mime_type, size_bytes, '
          + 'pixcli_asset_hash, provider_request_id'
          + `) SELECT ${artifactValues.map((value, index) => (
            index === 6 ? sqlInteger(value, `Artifact size for ${slot.slotKey}:${artifact.kind}`) : sqlString(value)
          )).join(', ')} WHERE (`
          + `SELECT index_content_hash FROM arcade_generation_experiments WHERE id = ${sqlString(plan.state.experimentId)}`
          + `) = ${sqlString(plan.indexContentHash)};`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function runWrangler(args, options = {}) {
  if (!existsSync(WRANGLER_CLI)) throw new Error('Pinned Wrangler is missing. Run npm --prefix worker ci.');
  const result = spawnSync(process.execPath, [WRANGLER_CLI, ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Wrangler failed (${args.slice(0, 3).join(' ')}): ${(result.stderr || result.stdout).trim()}`);
  }
  if (options.print !== false && result.stdout.trim()) process.stdout.write(result.stdout);
  return result.stdout;
}

function uploadAndVerifyObject(blobKey, bytes, mimeType, temporaryDir) {
  const localPath = join(temporaryDir, `${sha256(blobKey)}.upload`);
  const downloadedPath = join(temporaryDir, `${sha256(blobKey)}.download`);
  writeFileSync(localPath, bytes, { mode: 0o600 });
  runWrangler([
    'r2', 'object', 'put', `${R2_BUCKET}/${blobKey}`,
    '--file', localPath,
    '--content-type', mimeType,
    '--remote',
    '--jurisdiction', R2_JURISDICTION,
    '--config', WRANGLER_CONFIG,
  ]);
  runWrangler([
    'r2', 'object', 'get', `${R2_BUCKET}/${blobKey}`,
    '--file', downloadedPath,
    '--remote',
    '--jurisdiction', R2_JURISDICTION,
    '--config', WRANGLER_CONFIG,
  ]);
  const downloaded = readFileSync(downloadedPath);
  if (sha256(downloaded) !== sha256(bytes)) throw new Error(`R2 round-trip hash mismatch: ${blobKey}.`);
}

function parseWranglerJson(output) {
  const start = output.indexOf('[');
  if (start < 0) throw new Error('Wrangler did not return D1 JSON.');
  return JSON.parse(output.slice(start));
}

function verifyD1Index(plan) {
  const query = `SELECT index_content_hash, slot_count, artifact_count, state_content_hash, manifest_content_hash, `
    + `(SELECT COUNT(*) FROM arcade_generation_experiment_slots WHERE experiment_id = ${sqlString(plan.state.experimentId)}) AS actual_slot_count, `
    + `(SELECT COUNT(*) FROM arcade_generation_experiment_artifacts WHERE experiment_id = ${sqlString(plan.state.experimentId)}) AS actual_artifact_count `
    + `FROM arcade_generation_experiments WHERE id = ${sqlString(plan.state.experimentId)};`;
  const output = runWrangler([
    'd1', 'execute', D1_DATABASE,
    '--command', query,
    '--remote',
    '--config', WRANGLER_CONFIG,
    '--json',
  ], { print: false });
  const result = parseWranglerJson(output)?.[0]?.results?.[0];
  if (
    result?.index_content_hash !== plan.indexContentHash
    || result?.state_content_hash !== plan.stateContentHash
    || result?.manifest_content_hash !== plan.manifestContentHash
    || result?.slot_count !== plan.slots.length
    || result?.artifact_count !== plan.artifactCount
    || result?.actual_slot_count !== plan.slots.length
    || result?.actual_artifact_count !== plan.artifactCount
  ) {
    throw new Error(`D1 archive index verification failed: ${plan.state.experimentId}.`);
  }
}

export function archiveObjectList(plan) {
  return [
    ...plan.slots.flatMap((slot) => slot.artifacts.map((artifact) => ({
      blobKey: artifact.blobKey,
      bytes: readFileSync(artifact.localPath),
      mimeType: artifact.mimeType,
    }))),
    {
      blobKey: plan.stateBlobKey,
      bytes: plan.stateBytes,
      mimeType: 'application/json',
    },
    {
      blobKey: plan.manifestBlobKey,
      bytes: plan.manifestBytes,
      mimeType: 'application/json',
    },
  ];
}

export async function archiveArcadeExperiment(options) {
  const plan = buildArcadeExperimentArchivePlan(options);
  if (options.dryRun === true) return plan;
  const temporaryDir = mkdtempSync(join(tmpdir(), 'insert-player-arcade-archive-'));
  try {
    const uploadObject = options.uploadObject ?? ((object) => (
      uploadAndVerifyObject(object.blobKey, object.bytes, object.mimeType, temporaryDir)
    ));
    for (const object of archiveObjectList(plan)) await uploadObject(object);
    if (options.writeIndex) {
      await options.writeIndex(plan, buildArcadeExperimentIndexSql(plan));
    } else {
      const sqlPath = join(temporaryDir, 'archive.sql');
      writeFileSync(sqlPath, buildArcadeExperimentIndexSql(plan), { mode: 0o600 });
      runWrangler([
        'd1', 'execute', D1_DATABASE,
        '--file', sqlPath,
        '--remote',
        '--config', WRANGLER_CONFIG,
        '--yes',
      ]);
      verifyD1Index(plan);
    }
    return plan;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const experimentId = parseArg(rawArgs, '--experiment');
  if (!experimentId) throw new Error('--experiment is required.');
  const dryRun = rawArgs.includes('--dry-run');
  if (!dryRun) {
    const confirmation = parseArg(rawArgs, '--confirm');
    if (!rawArgs.includes('--execute') || confirmation !== CONFIRMATION) {
      throw new Error(`Production archive requires --execute --confirm=${CONFIRMATION}.`);
    }
  }
  const plan = await archiveArcadeExperiment({
    experimentId,
    catalogPath: parseArg(rawArgs, '--catalog', DEFAULT_CATALOG_PATH),
    rootDir: root,
    dryRun,
  });
  console.log(
    `${dryRun ? 'Verified' : 'Archived'} ${plan.state.experimentId}: `
      + `${plan.slots.length} slots, ${plan.artifactCount} artifacts, manifest ${plan.manifestContentHash}.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
