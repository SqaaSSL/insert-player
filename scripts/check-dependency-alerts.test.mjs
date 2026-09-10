import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateDependencyAlerts, readDependabotAlerts } from './check-dependency-alerts.mjs';

const roots = [];
function fixture(packages = {}, { manifest = 'worker/package-lock.json', lockfileVersion = 3 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'insert-player-dependency-alert-'));
  roots.push(root);
  mkdirSync(dirname(join(root, manifest)), { recursive: true });
  writeFileSync(join(root, manifest), JSON.stringify({ lockfileVersion, packages: { '': {}, ...packages } }));
  return root;
}

function alert({ severity = 'high', state = 'open', name = 'sharp', ecosystem = 'npm', range = '< 0.35.4', manifest = 'worker/package-lock.json' } = {}) {
  return {
    number: 3, state,
    dependency: { manifest_path: manifest, package: { name, ecosystem } },
    security_advisory: { severity },
    security_vulnerability: { severity, package: { name, ecosystem }, vulnerable_version_range: range },
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Dependabot alerts against the current checkout', () => {
  it.each([2, 3])('allows a patched npm lockfile v%s while the default-branch alert stays open', (lockfileVersion) => {
    const root = fixture({ 'node_modules/sharp': { version: '0.35.4' } }, { lockfileVersion });
    const result = evaluateDependencyAlerts([alert()], { root });
    expect(result.blocking).toEqual([]);
    expect(result.fixedInCheckout).toEqual([expect.stringContaining('all locked versions are outside the vulnerable range')]);
  });

  it('rejects every vulnerable nested occurrence even when the top-level package is patched', () => {
    const root = fixture({
      'node_modules/sharp': { version: '0.35.4' },
      'node_modules/takumi/node_modules/sharp': { version: '0.35.3', optional: true },
      'node_modules/other/node_modules/deeper/node_modules/sharp': { version: '0.34.5', dev: true },
    });
    const result = evaluateDependencyAlerts([alert()], { root });
    expect(result.fixedInCheckout).toEqual([]);
    expect(result.blocking).toEqual([expect.stringContaining('0.35.3 (node_modules/takumi/node_modules/sharp)')]);
    expect(result.blocking[0]).toContain('0.34.5 (node_modules/other/node_modules/deeper/node_modules/sharp)');
  });

  it('recognizes scoped packages and real npm package names behind aliases', () => {
    const root = fixture({
      'node_modules/safe-looking-alias': { name: 'sharp', version: '0.35.3' },
      'node_modules/x/node_modules/@scope/runtime': { version: '1.0.0' },
    });
    expect(evaluateDependencyAlerts([alert()], { root }).blocking[0]).toContain('safe-looking-alias');
    expect(evaluateDependencyAlerts([alert({ name: '@scope/runtime', range: '< 2.0.0' })], { root }).blocking[0])
      .toContain('@scope/runtime');
  });

  it('allows removal of the affected package from a valid current lockfile', () => {
    const root = fixture({ 'node_modules/safe': { version: '1.0.0' } });
    expect(evaluateDependencyAlerts([alert()], { root })).toEqual({
      blocking: [], fixedInCheckout: [expect.stringContaining('package is absent from this lockfile')],
    });
  });

  it('normalizes GitHub comparator commas and handles disjoint vulnerable intervals', () => {
    const range = '>= 1.0.0, < 1.2.3 || >= 2.0.0, < 2.0.2';
    for (const [version, blocked] of [['1.2.2', true], ['1.2.3', false], ['2.0.1', true], ['2.0.2', false]]) {
      const root = fixture({ 'node_modules/sharp': { version } });
      expect(evaluateDependencyAlerts([alert({ range })], { root }).blocking.length > 0).toBe(blocked);
    }
  });

  it('does not let a prerelease evade an advisory or mistake build metadata for a new version', () => {
    const root = fixture({ 'node_modules/sharp': { version: '0.35.4-rc.1' } });
    expect(evaluateDependencyAlerts([alert()], { root }).blocking).toHaveLength(1);
    const build = fixture({ 'node_modules/sharp': { version: '0.35.3+build.42' } });
    expect(evaluateDependencyAlerts([alert()], { root: build }).blocking).toHaveLength(1);
  });

  it('uses the exact referenced lockfile and the highest reported severity', () => {
    const root = fixture({ 'node_modules/sharp': { version: '0.35.4' } });
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/sharp': { version: '0.35.3' } } }));
    const mixedSeverity = alert({ manifest: 'package-lock.json', severity: 'medium' });
    mixedSeverity.security_vulnerability.severity = 'critical';
    expect(evaluateDependencyAlerts([mixedSeverity], { root }).blocking[0]).toContain('[critical] package-lock.json');
    expect(evaluateDependencyAlerts([alert()], { root }).blocking).toEqual([]);
  });

  it('keeps the existing high/critical threshold without suppressing affected open alerts', () => {
    const root = fixture({ 'node_modules/sharp': { version: '0.35.3' } });
    expect(evaluateDependencyAlerts([alert({ severity: 'medium' }), alert({ state: 'fixed' })], { root }).blocking).toEqual([]);
    expect(evaluateDependencyAlerts([alert({ severity: 'critical' })], { root }).blocking).toHaveLength(1);
  });

  it.each([undefined, null, '', 'not-a-range', '>= 1.0.0,, < 2.0.0', '< 2.0.0,'])('fails closed on malformed range %s even if the package was removed', (range) => {
    const value = alert();
    value.security_vulnerability.vulnerable_version_range = range;
    expect(() => evaluateDependencyAlerts([value], { root: fixture() })).toThrow(/range/);
  });

  it.each([undefined, null, '', 'latest', 'v0.35.4', '0.35', '0.35.3 invalid', ' 0.35.4', 35])('fails closed on invalid locked version %s', (version) => {
    const root = fixture({ 'node_modules/sharp': { version } });
    expect(() => evaluateDependencyAlerts([alert()], { root })).toThrow(/locked version/);
  });

  it.each(['../package-lock.json', '/tmp/package-lock.json', 'worker/../../package-lock.json', 'worker\\package-lock.json', 'worker/./package-lock.json', 'worker/package.json', 'yarn.lock'])('rejects unsafe or unsupported manifest %s', (manifest) => {
    expect(() => evaluateDependencyAlerts([alert({ manifest })], { root: fixture() })).toThrow(/manifest|path/);
  });

  it('rejects missing and symlink-escaped manifests rather than treating them as removed dependencies', () => {
    const root = fixture();
    expect(() => evaluateDependencyAlerts([alert({ manifest: 'missing/package-lock.json' })], { root })).toThrow();
    const outside = fixture();
    mkdirSync(join(root, 'escape'));
    symlinkSync(join(outside, 'worker/package-lock.json'), join(root, 'escape/package-lock.json'));
    expect(() => evaluateDependencyAlerts([alert({ manifest: 'escape/package-lock.json' })], { root })).toThrow(/escapes/);
  });

  it.each([
    'not-json', JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
    JSON.stringify({ lockfileVersion: 3 }), JSON.stringify({ lockfileVersion: 3, packages: [] }),
    JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/sharp': { version: '0.35.4' } } }),
  ])('rejects malformed or unsupported lockfile content', (source) => {
    const root = fixture();
    writeFileSync(join(root, 'worker/package-lock.json'), source);
    expect(() => evaluateDependencyAlerts([alert()], { root })).toThrow();
  });

  it.each([
    { 'node_modules/sharp': null },
    { 'node_modules/sharp': { link: true, resolved: '../sharp' } },
    { '../node_modules/sharp': { version: '0.35.4' } },
    { 'node_modules/alias': { name: 42, version: '0.35.4' } },
    { 'workspace/sharp': { version: '0.35.4' } },
  ])('rejects malformed or unsupported package entries', (packages) => {
    expect(() => evaluateDependencyAlerts([alert()], { root: fixture(packages) })).toThrow();
  });

  it('rejects unsupported or mismatched advisory identity and missing alert fields', () => {
    const root = fixture();
    const mismatched = alert();
    mismatched.security_vulnerability.package.name = 'another-package';
    for (const value of [alert({ ecosystem: 'pip' }), mismatched, { ...alert(), state: undefined }, alert({ severity: 'unknown' }), null]) {
      expect(() => evaluateDependencyAlerts([value], { root })).toThrow();
    }
    expect(() => evaluateDependencyAlerts({}, { root })).toThrow();
  });
});

describe('Dependabot API loading', () => {
  it('requests every page and retains alerts from later pages', () => {
    const execute = vi.fn(() => JSON.stringify([[alert({ severity: 'medium' })], [alert()]]));
    const loaded = readDependabotAlerts('owner/repo', { execute });
    expect(loaded).toHaveLength(2);
    expect(execute).toHaveBeenCalledWith('gh', expect.arrayContaining([
      'repos/owner/repo/dependabot/alerts', 'state=open', '--paginate', '--slurp',
    ]), expect.objectContaining({ encoding: 'utf8' }));
    const root = fixture({ 'node_modules/sharp': { version: '0.35.3' } });
    expect(evaluateDependencyAlerts(loaded, { root }).blocking).toHaveLength(1);
    expect(readDependabotAlerts('owner/repo', { execute: () => '[[]]' })).toEqual([]);
  });

  it('fails closed for API errors, malformed JSON, and incomplete pagination envelopes', () => {
    expect(() => readDependabotAlerts('owner/repo', { execute: () => { throw new Error('403'); } })).toThrow(/fails closed/);
    for (const response of ['not-json', '{}', '[]', '[{}]', '[[], {"message":"API rate limit exceeded"}]']) {
      expect(() => readDependabotAlerts('owner/repo', { execute: () => response })).toThrow();
    }
    expect(() => readDependabotAlerts('../other/repo', { execute: vi.fn() })).toThrow(/GITHUB_REPOSITORY/);
  });
});
