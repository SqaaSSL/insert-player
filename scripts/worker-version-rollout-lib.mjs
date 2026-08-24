const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PRODUCTION_VERSION_TAG_PATTERN = /^prod-([0-9a-f]{40})-([1-9][0-9]*)$/i;

export function assertWorkerVersionId(value, label = 'Worker version id') {
  const normalized = String(value ?? '').trim();
  if (!VERSION_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return normalized;
}

export function stableVersionIdFromDeployment(payload) {
  const versions = Array.isArray(payload?.versions) ? payload.versions : [];
  if (versions.length !== 1 || Number(versions[0]?.percentage) !== 100) {
    throw new Error('Expected one stable Worker version serving exactly 100% of traffic.');
  }
  return assertWorkerVersionId(versions[0]?.version_id, 'Stable Worker version id');
}

export function stableGitShaFromVersion({
  versionId,
  viewedVersionId,
  tag,
  bootstrapVersionId,
  bootstrapGitSha,
}) {
  const stableVersionId = assertWorkerVersionId(versionId, 'Stable Worker version id');
  const inspectedVersionId = assertWorkerVersionId(viewedVersionId, 'Inspected Worker version id');
  if (inspectedVersionId !== stableVersionId) {
    throw new Error('Inspected Worker version does not match the stable deployment.');
  }

  const tagMatch = String(tag ?? '').trim().match(PRODUCTION_VERSION_TAG_PATTERN);
  if (tagMatch) return tagMatch[1].toLowerCase();

  const expectedBootstrapVersion = String(bootstrapVersionId ?? '').trim();
  const expectedBootstrapSha = String(bootstrapGitSha ?? '').trim();
  if (
    !VERSION_ID_PATTERN.test(expectedBootstrapVersion)
    || expectedBootstrapVersion !== stableVersionId
    || !GIT_SHA_PATTERN.test(expectedBootstrapSha)
  ) {
    throw new Error(
      'Stable Worker version has no production git tag and does not match the audited bootstrap version.',
    );
  }
  return expectedBootstrapSha.toLowerCase();
}

export function assertDeploymentTopology(payload, expectedVersions) {
  const actual = Array.isArray(payload?.versions) ? payload.versions : [];
  if (actual.length !== expectedVersions.length) {
    throw new Error(`Expected ${expectedVersions.length} deployed Worker versions, found ${actual.length}.`);
  }
  for (const expected of expectedVersions) {
    const versionId = assertWorkerVersionId(expected.versionId, 'Expected Worker version id');
    const matches = actual.filter((entry) => entry?.version_id === versionId);
    if (matches.length !== 1 || Number(matches[0]?.percentage) !== expected.percentage) {
      throw new Error(`Worker version ${versionId} is not serving exactly ${expected.percentage}%.`);
    }
  }
}

export function assertVersionUploadCompatible(files, wranglerDiff = '') {
  const blockedFiles = files.filter((file) => (
    file === 'Dockerfile.processor'
    || file.startsWith('processor/')
  ));
  if (blockedFiles.length > 0) {
    throw new Error(`Worker-only rollout cannot include Container changes: ${blockedFiles.join(', ')}`);
  }
  assertNoDurableObjectLifecycleChange(wranglerDiff);
}

export function assertFullDeployCompatible(wranglerDiff = '') {
  assertNoDurableObjectLifecycleChange(wranglerDiff);
}

function assertNoDurableObjectLifecycleChange(wranglerDiff) {
  const lifecycleChange = String(wranglerDiff)
    .split(/\r?\n/)
    .filter((line) => /^[+-](?![+-])/.test(line))
    .some((line) => /(\[\[migrations\]\]|new_sqlite_classes|new_classes|renamed_classes|deleted_classes|class_name\s*=)/.test(line));
  if (lifecycleChange) {
    throw new Error('Rollback-safe rollout cannot include Durable Object lifecycle changes.');
  }
}

export function versionIdFromWranglerOutput(text, expectedWorkerName) {
  const entries = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const uploads = entries.filter((entry) => (
    entry?.type === 'version-upload'
    && (!expectedWorkerName || entry?.worker_name === expectedWorkerName)
  ));
  if (uploads.length !== 1) {
    throw new Error(`Expected one Wrangler version-upload record, found ${uploads.length}.`);
  }
  return assertWorkerVersionId(uploads[0]?.version_id, 'Candidate Worker version id');
}

export function activeGenerationJobsFromWranglerOutput(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('Could not parse the D1 generation-idle response.');
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  const rows = envelopes.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
  if (rows.length !== 1 || !Number.isInteger(Number(rows[0]?.active_jobs))) {
    throw new Error('D1 generation-idle response did not contain one active_jobs count.');
  }
  return Number(rows[0].active_jobs);
}
