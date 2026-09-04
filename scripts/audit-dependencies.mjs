import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyAuditResult,
  formatAuditCounts,
} from './dependency-audit-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const projects = [
  { label: 'frontend', directory: root },
  { label: 'Worker', directory: join(root, 'worker') },
  { label: 'processor', directory: join(root, 'processor') },
];

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const maxAttempts = positiveInteger(process.env.DEPENDENCY_AUDIT_MAX_ATTEMPTS, 2);
const timeoutMs = positiveInteger(process.env.DEPENDENCY_AUDIT_TIMEOUT_MS, 8 * 60_000);
const retryDelayMs = positiveInteger(process.env.DEPENDENCY_AUDIT_RETRY_DELAY_MS, 10_000);
const maxCapturedBytes = 10 * 1024 * 1024;

function appendCaptured(current, chunk) {
  if (current.length >= maxCapturedBytes) return current;
  return `${current}${String(chunk)}`.slice(0, maxCapturedBytes);
}

function runNpmAudit(project) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, [
      'audit',
      '--package-lock-only',
      '--audit-level=high',
      '--json',
    ], {
      cwd: project.directory,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKillTimer;

    child.stdout.on('data', (chunk) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendCaptured(stderr, chunk);
    });
    child.on('error', reject);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function conciseDiagnostic(result) {
  const diagnostic = `${result.stderr}\n${result.stdout}`.trim();
  if (!diagnostic) return '(no diagnostic output)';
  const limit = 4_000;
  return diagnostic.length > limit
    ? `${diagnostic.slice(0, limit)}\n... output truncated ...`
    : diagnostic;
}

async function auditProject(project) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`[dependency-audit] ${project.label}: attempt ${attempt}/${maxAttempts}`);
    let result;
    try {
      result = await runNpmAudit(project);
    } catch (error) {
      result = {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
    }

    const outcome = classifyAuditResult(result);
    if (outcome.kind === 'passed') {
      console.log(
        `[dependency-audit] ${project.label}: passed (${formatAuditCounts(outcome.vulnerabilities)})`,
      );
      return { project, outcome, result };
    }

    if (outcome.kind === 'vulnerabilities') {
      console.error(
        `[dependency-audit] ${project.label}: blocked (${formatAuditCounts(outcome.vulnerabilities)})`,
      );
      console.error(conciseDiagnostic(result));
      return { project, outcome, result };
    }

    if (outcome.retryable && attempt < maxAttempts) {
      const reason = result.timedOut ? `timed out after ${timeoutMs}ms` : 'registry/network failure';
      console.warn(`[dependency-audit] ${project.label}: ${reason}; retrying.`);
      console.warn(conciseDiagnostic(result));
      await sleep(retryDelayMs);
      continue;
    }

    console.error(
      `[dependency-audit] ${project.label}: ${outcome.retryable ? 'registry unavailable after retries' : 'audit command failed'}.`,
    );
    console.error(conciseDiagnostic(result));
    return { project, outcome, result };
  }

  throw new Error(`Dependency audit attempts exhausted unexpectedly for ${project.label}.`);
}

console.log(
  `[dependency-audit] Auditing ${projects.length} lockfiles concurrently; `
  + `${maxAttempts} attempt(s), ${timeoutMs}ms timeout per attempt.`,
);
const results = await Promise.all(projects.map(auditProject));
const failures = results.filter(({ outcome }) => outcome.kind !== 'passed');
if (failures.length > 0) {
  console.error(
    `[dependency-audit] Gate failed for: ${failures.map(({ project }) => project.label).join(', ')}.`,
  );
  process.exitCode = 1;
} else {
  console.log('[dependency-audit] All dependency lockfiles passed.');
}
