import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const children = new Set();
const temporaryDirectories = new Set();

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function startAuditServer(outputDirectory) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [
    join(root, 'scripts', 'serve-legacy-cache-audit.mjs'),
    `--port=${port}`,
    `--output-dir=${outputDirectory}`,
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`Audit server startup timed out: ${stderr}`)), 5_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('Read-only legacy cache audit listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Audit server exited during startup with ${code}: ${stderr}`));
    });
  });
  return { child, origin: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1_000);
    });
  }
  children.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('legacy cache audit server', () => {
  it('serves a read-only audit and preserves existing exports', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'insert-player-cache-audit-'));
    temporaryDirectories.add(outputDirectory);
    const { origin } = await startAuditServer(outputDirectory);

    const pageResponse = await fetch(origin);
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get('cache-control')).toBe('no-store');
    expect(pageResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await pageResponse.text()).toContain('Insert Player local cache audit');

    const scriptResponse = await fetch(`${origin}/audit.js`);
    const browserScript = await scriptResponse.text();
    expect(scriptResponse.status).toBe(200);
    expect(browserScript).toContain("database.transaction(storeName, 'readonly')");
    expect(browserScript).not.toMatch(/objectStore\([^)]*\)\.(?:add|clear|delete|put)\s*\(/);

    const invalidResponse = await fetch(`${origin}/export?filename=../escape.tar`, {
      method: 'POST',
      body: Buffer.from('invalid'),
    });
    expect(invalidResponse.status).toBe(400);

    const payload = Buffer.from('lossless-archive-fixture');
    const filename = 'localhost--fighter--hash--20260825.tar';
    const firstExport = await fetch(`${origin}/export?filename=${filename}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-tar' },
      body: payload,
    });
    expect(firstExport.status).toBe(201);
    expect(readFileSync(join(outputDirectory, filename))).toEqual(payload);

    const duplicateExport = await fetch(`${origin}/export?filename=${filename}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-tar' },
      body: Buffer.from('replacement'),
    });
    expect(duplicateExport.status).toBe(409);
    expect(readFileSync(join(outputDirectory, filename))).toEqual(payload);
  });
});
