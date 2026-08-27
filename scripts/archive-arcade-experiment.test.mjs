import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveArcadeExperiment,
  archiveObjectList,
  buildArcadeExperimentArchivePlan,
  buildArcadeExperimentIndexSql,
  uploadAndVerifyObjectThroughBridge,
} from './archive-arcade-experiment.mjs';

const temporaryDirectories = [];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeFixtureFile(root, path, bytes) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  return {
    pixcliAssetHash: sha256(bytes).slice(0, 32),
    mimeType: path.endsWith('.json') ? 'application/json' : 'image/png',
    contentSha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    path,
    providerRequestId: 'provider-request-1',
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'archive-arcade-experiment-test-'));
  temporaryDirectories.push(root);
  const request = Buffer.from('{"request":true}\n');
  const response = Buffer.from('{"response":true}\n');
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const artifacts = {
    provider_request: writeFixtureFile(root, '.artifacts/experiment/fighter--model--provider_request.json', request),
    provider_response: writeFixtureFile(root, '.artifacts/experiment/fighter--model--provider_response.json', response),
    image: writeFixtureFile(root, '.artifacts/experiment/fighter--model--image.png', image),
  };
  const state = {
    schemaVersion: 2,
    experimentId: 'archive-test-v1',
    matrixSha256: 'a'.repeat(64),
    status: 'complete',
    createdAt: '2026-08-25T00:00:00.000Z',
    completedAt: '2026-08-25T00:01:00.000Z',
    policy: {
      expectedPaidCalls: 1,
      retries: 0,
      fallback: 'none',
      promptEnrichment: false,
      activation: false,
    },
    slots: {
      'fighter:motion:model:profile': {
        slotKey: 'fighter:motion:model:profile',
        slug: 'fighter',
        fighterName: "Fighter O'Clock",
        modelId: 'model',
        providerEndpoint: 'provider/model',
        sourceSha256: 'b'.repeat(64),
        promptSha256: 'c'.repeat(64),
        requestSha256: 'd'.repeat(64),
        status: 'completed',
        pixcliJobId: 'job-1',
        providerRuns: [{ requestId: 'provider-request-1' }],
        pixcliCostEstimate: 70000,
        artifacts,
        completedAt: '2026-08-25T00:01:00.000Z',
      },
    },
  };
  const statePath = '.arcade-test-state.json';
  const stateBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(root, statePath), stateBytes);
  const catalog = {
    schemaVersion: 1,
    repository: 'SqaaSSL/insert-player',
    experiments: [{
      experimentId: state.experimentId,
      githubRunId: 123,
      githubArtifactName: 'archive-test-state',
      statePath,
      stateSha256: sha256(stateBytes),
    }],
  };
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return { root, catalogPath, statePath, state, artifacts };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('immutable Arcade experiment archive', () => {
  it('verifies every sealed byte and builds content-addressed R2 objects', () => {
    const data = fixture();
    const plan = buildArcadeExperimentArchivePlan({
      rootDir: data.root,
      catalogPath: data.catalogPath,
      experimentId: data.state.experimentId,
    });

    expect(plan.slots).toHaveLength(1);
    expect(plan.artifactCount).toBe(3);
    expect(plan.stateContentHash).toBe(sha256(readFileSync(join(data.root, data.statePath))));
    expect(plan.slots[0].artifacts.map((artifact) => artifact.blobKey)).toEqual([
      expect.stringMatching(/^arcade-experiments\/v1\/archive-test-v1\/slots\/[a-f0-9]{20}\/image\/[a-f0-9]{64}\.png$/),
      expect.stringMatching(/^arcade-experiments\/v1\/archive-test-v1\/slots\/[a-f0-9]{20}\/provider_request\/[a-f0-9]{64}\.json$/),
      expect.stringMatching(/^arcade-experiments\/v1\/archive-test-v1\/slots\/[a-f0-9]{20}\/provider_response\/[a-f0-9]{64}\.json$/),
    ]);
    expect(archiveObjectList(plan)).toHaveLength(5);
    expect(plan.manifest.slots[0]).not.toHaveProperty('artifacts.0.localPath');
  });

  it('builds append-only, idempotent SQL and escapes text values', () => {
    const data = fixture();
    const plan = buildArcadeExperimentArchivePlan({
      rootDir: data.root,
      catalogPath: data.catalogPath,
      experimentId: data.state.experimentId,
    });
    const sql = buildArcadeExperimentIndexSql(plan);

    expect(sql).toContain('managed batch');
    expect(sql).toContain('INSERT OR IGNORE INTO arcade_generation_experiments');
    expect(sql).toContain("Fighter O''Clock");
    expect(sql).toContain(plan.indexContentHash);
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bUPDATE\b|\bDELETE\b/);
  });

  it('uploads state, manifest, and artifacts before writing the immutable index', async () => {
    const data = fixture();
    const uploaded = [];
    const writeIndex = vi.fn();
    const plan = await archiveArcadeExperiment({
      rootDir: data.root,
      catalogPath: data.catalogPath,
      experimentId: data.state.experimentId,
      uploadObject: async (object) => uploaded.push(object.blobKey),
      writeIndex,
    });

    expect(uploaded).toHaveLength(5);
    expect(uploaded.at(-2)).toBe(plan.stateBlobKey);
    expect(uploaded.at(-1)).toBe(plan.manifestBlobKey);
    expect(writeIndex).toHaveBeenCalledOnce();
  });

  it('round-trips exact bytes through the isolated R2 upload bridge', async () => {
    const bytes = Buffer.from('sealed bytes');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: 'stored' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    await uploadAndVerifyObjectThroughBridge({
      blobKey: 'arcade-experiments/v1/archive-test-v1/state/hash.json',
      bytes,
      mimeType: 'application/json',
    }, {
      bridge: {
        url: 'https://temporary-archive.shellbot.workers.dev/archive-object',
        token: 'a'.repeat(64),
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: bytes, redirect: 'error' });
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
      Authorization: `Bearer ${'a'.repeat(64)}`,
      'X-Archive-Content-Sha256': sha256(bytes),
      'X-Archive-Size': String(bytes.byteLength),
    });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('fails closed when only half of the upload bridge configuration is present', async () => {
    const data = fixture();
    await expect(archiveArcadeExperiment({
      rootDir: data.root,
      catalogPath: data.catalogPath,
      experimentId: data.state.experimentId,
      env: { ARCADE_ARCHIVE_UPLOAD_URL: 'https://archive.shellbot.workers.dev/archive-object' },
    })).rejects.toThrow(/must be configured together/);
  });

  it('fails closed on changed bytes or a path outside the workspace', () => {
    const data = fixture();
    writeFileSync(join(data.root, data.artifacts.image.path), Buffer.from('changed'));
    expect(() => buildArcadeExperimentArchivePlan({
      rootDir: data.root,
      catalogPath: data.catalogPath,
      experimentId: data.state.experimentId,
    })).toThrow(/do not match the sealed state/);

    const next = fixture();
    const parsed = JSON.parse(readFileSync(join(next.root, next.statePath), 'utf8'));
    parsed.slots['fighter:motion:model:profile'].artifacts.image.path = '../outside.png';
    const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
    writeFileSync(join(next.root, next.statePath), bytes);
    const catalog = JSON.parse(readFileSync(next.catalogPath, 'utf8'));
    catalog.experiments[0].stateSha256 = sha256(bytes);
    writeFileSync(next.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    expect(() => buildArcadeExperimentArchivePlan({
      rootDir: next.root,
      catalogPath: next.catalogPath,
      experimentId: next.state.experimentId,
    })).toThrow(/escapes the archive workspace/);
  });
});
