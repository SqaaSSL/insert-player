import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const script = new URL('./encrypted-workflow-bundle.mjs', import.meta.url);
const workflow = new URL(
  '../.github/workflows/arcade-imported-video-recuration-production.yml',
  import.meta.url,
);
const roots = [];
const key = '17'.repeat(32);

function root() {
  const directory = mkdtempSync(join(tmpdir(), 'encrypted-workflow-bundle-test-'));
  roots.push(directory);
  return directory;
}

function run(args) {
  return spawnSync(process.execPath, [script.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ARCADE_RECURATION_ARTIFACT_KEY: key },
  });
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('encrypted production workflow bundle', () => {
  it('keeps long-lived secrets step-scoped and pins every external action immutably', () => {
    const source = readFileSync(workflow, 'utf8');
    expect(source).not.toMatch(/^ {6}(?:ASF_ARCADE_CLERK|ASF_ARCADE_ADMIN|CLERK_BACKEND|ARCADE_RECURATION).*secrets\./m);
    const uses = [...source.matchAll(/^\s+uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((reference) => /@[a-f0-9]{40}$/.test(reference))).toBe(true);
    expect(source).toContain('path: ${{ runner.temp }}/imported-stage-artifact');
    expect(source).toContain('path: ${{ runner.temp }}/imported-transition-artifact');
    expect(source).not.toContain('path: ${{ runner.temp }}/imported-stage\n');
    expect(source).not.toContain('path: ${{ runner.temp }}/imported-transition\n');
  });

  it('round-trips private evidence without exposing its plaintext in the artifact', () => {
    const directory = root();
    const source = join(directory, 'source');
    const destination = join(directory, 'opened');
    const bundle = join(directory, 'artifact', 'bundle.enc');
    mkdirSync(join(source, 'nested'), { recursive: true });
    const privateMarker = 'private-mp4-marker-that-must-never-appear-in-github-artifacts';
    writeFileSync(join(source, 'video.mp4'), privateMarker);
    writeFileSync(join(source, 'nested', 'descriptor.json'), '{"sealed":true}\n');

    const sealed = run([
      '--operation=seal', `--source-dir=${source}`, `--bundle=${bundle}`,
    ]);
    expect(sealed.status, sealed.stderr).toBe(0);
    expect(readFileSync(bundle).includes(Buffer.from(privateMarker))).toBe(false);

    const opened = run([
      '--operation=open', `--bundle=${bundle}`, `--destination-dir=${destination}`,
    ]);
    expect(opened.status, opened.stderr).toBe(0);
    expect(readFileSync(join(destination, 'video.mp4'), 'utf8')).toBe(privateMarker);
    expect(readFileSync(join(destination, 'nested', 'descriptor.json'), 'utf8')).toBe('{"sealed":true}\n');
  });

  it('fails closed for a changed ciphertext or a wrong key', () => {
    const directory = root();
    const source = join(directory, 'source');
    const bundle = join(directory, 'bundle.enc');
    mkdirSync(source);
    writeFileSync(join(source, 'runtime.png'), 'private-runtime');
    expect(run(['--operation=seal', `--source-dir=${source}`, `--bundle=${bundle}`]).status).toBe(0);

    const bytes = readFileSync(bundle);
    bytes[bytes.length - 17] ^= 0xff;
    writeFileSync(bundle, bytes);
    const changed = run([
      '--operation=open', `--bundle=${bundle}`, `--destination-dir=${join(directory, 'changed')}`,
    ]);
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toMatch(/sidecar|authentication/i);

    const other = root();
    const otherSource = join(other, 'source');
    const otherBundle = join(other, 'bundle.enc');
    mkdirSync(otherSource);
    writeFileSync(join(otherSource, 'raw.png'), 'private-raw');
    expect(run(['--operation=seal', `--source-dir=${otherSource}`, `--bundle=${otherBundle}`]).status).toBe(0);
    const wrongKey = spawnSync(process.execPath, [
      script.pathname,
      '--operation=open',
      `--bundle=${otherBundle}`,
      `--destination-dir=${join(other, 'wrong-key')}`,
    ], {
      encoding: 'utf8',
      env: { ...process.env, ARCADE_RECURATION_ARTIFACT_KEY: '42'.repeat(32) },
    });
    expect(wrongKey.status).not.toBe(0);
    expect(wrongKey.stderr).toMatch(/authentication/i);
  });
});
