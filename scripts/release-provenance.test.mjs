import { describe, expect, it } from 'vitest';
import {
  createFrontendReleaseManifest,
  frontendReleaseManifestIssue,
} from './release-provenance.mjs';

const SHA = 'c'.repeat(40);
const ENTRY = '/assets/index-release123.js';

describe('frontend release provenance', () => {
  it('builds a stable, non-secret production manifest', () => {
    const manifest = createFrontendReleaseManifest({
      context: {
        channel: 'github-actions',
        gitSha: SHA,
        runId: '456',
        runAttempt: '2',
      },
      entryAssetPath: ENTRY,
      builtAt: new Date('2026-09-04T08:00:00.000Z'),
    });
    expect(manifest).toEqual({
      schemaVersion: 1,
      application: 'insert-player',
      environment: 'production',
      gitSha: SHA,
      channel: 'github-actions',
      githubRunId: '456',
      githubRunAttempt: '2',
      entryAssetPath: ENTRY,
      builtAt: '2026-09-04T08:00:00.000Z',
    });
    expect(frontendReleaseManifestIssue(manifest, {
      expectedGitSha: SHA,
      expectedEntryAssetPath: ENTRY,
    })).toBe('');
  });

  it('rejects a release from a different commit or bundle', () => {
    const manifest = createFrontendReleaseManifest({
      context: { channel: 'break-glass', gitSha: SHA },
      entryAssetPath: ENTRY,
    });
    expect(frontendReleaseManifestIssue(manifest, {
      expectedGitSha: 'd'.repeat(40),
      expectedEntryAssetPath: ENTRY,
    })).toMatch(/gitSha/);
    expect(frontendReleaseManifestIssue(manifest, {
      expectedGitSha: SHA,
      expectedEntryAssetPath: '/assets/index-other.js',
    })).toMatch(/entryAssetPath/);
  });

  it('rejects malformed provenance inputs', () => {
    expect(() => createFrontendReleaseManifest({
      context: { channel: 'github-actions', gitSha: 'short' },
      entryAssetPath: ENTRY,
    })).toThrow(/full Git SHA/);
    expect(() => createFrontendReleaseManifest({
      context: { channel: 'local', gitSha: SHA },
      entryAssetPath: ENTRY,
    })).toThrow(/channel/);
  });
});
