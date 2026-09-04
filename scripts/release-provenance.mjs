import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FULL_GIT_SHA } from './production-deploy-guard-lib.mjs';

const ENTRY_ASSET = /^\/assets\/[A-Za-z0-9._-]+\.js$/;

export function createFrontendReleaseManifest({ context, entryAssetPath, builtAt = new Date() }) {
  if (!context || !FULL_GIT_SHA.test(context.gitSha ?? '')) {
    throw new Error('Frontend release provenance requires a full Git SHA.');
  }
  if (!['github-actions', 'break-glass'].includes(context.channel)) {
    throw new Error('Frontend release provenance has an invalid deployment channel.');
  }
  if (!ENTRY_ASSET.test(entryAssetPath ?? '')) {
    throw new Error('Frontend release provenance has an invalid entry asset path.');
  }
  const timestamp = builtAt instanceof Date ? builtAt : new Date(builtAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('Frontend release provenance has an invalid build timestamp.');
  }
  return {
    schemaVersion: 1,
    application: 'insert-player',
    environment: 'production',
    gitSha: context.gitSha,
    channel: context.channel,
    githubRunId: context.runId ?? null,
    githubRunAttempt: context.runAttempt ?? null,
    entryAssetPath,
    builtAt: timestamp.toISOString(),
  };
}

export function writeFrontendReleaseManifest({ distDir, context, entryAssetPath, builtAt }) {
  const manifest = createFrontendReleaseManifest({ context, entryAssetPath, builtAt });
  writeFileSync(join(distDir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function frontendReleaseManifestIssue(manifest, { expectedGitSha, expectedEntryAssetPath }) {
  if (!manifest || typeof manifest !== 'object') return 'release.json is not an object';
  if (manifest.schemaVersion !== 1) return 'release.json has an unsupported schema';
  if (manifest.application !== 'insert-player') return 'release.json identifies the wrong application';
  if (manifest.environment !== 'production') return 'release.json identifies the wrong environment';
  if (manifest.gitSha !== expectedGitSha) return `release.json gitSha is ${manifest.gitSha || 'missing'}`;
  if (manifest.entryAssetPath !== expectedEntryAssetPath) {
    return `release.json entryAssetPath is ${manifest.entryAssetPath || 'missing'}`;
  }
  if (!['github-actions', 'break-glass'].includes(manifest.channel)) {
    return 'release.json has an invalid deployment channel';
  }
  if (!Number.isFinite(Date.parse(manifest.builtAt))) return 'release.json has an invalid builtAt timestamp';
  return '';
}
