import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PRIVILEGED_VALUE = /\$\{\{\s*(?:secrets|vars)\.[A-Za-z0-9_]+\s*\}\}/;
const REMOTE_MUTATION = /(?:\bwrangler\b[^\n]*(?:deploy|rollback|delete|secret|d1|r2|pages|versions)|npm run (?:config:|deploy:|db:migrate))/;
const CURRENT_RELEASE = "steps.queued-release.outputs.current == 'true'";

// The workflows use block-style YAML. Keep these checks scoped to the actual
// mapping/step, so a comment or an unrelated job cannot satisfy a release gate.
function mappingBlock(source, key, indent) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^ {${indent}}${key}:`).test(line));
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

function field(source, key, indent) {
  return source.match(new RegExp(`^ {${indent}}${key}:[ \\t]*([^\\n]*)$`, 'm'))?.[1]
    .replace(/\s+#.*$/, '').trim() ?? '';
}

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function expression(value) {
  return value.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').trim();
}

function jobSteps(source) {
  const block = mappingBlock(source, 'steps', 4);
  const lines = block.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => /^      - /.test(line) ? [index] : []);
  return starts.map((start, index) => {
    const normalized = lines.slice(start, starts[index + 1] ?? lines.length).join('\n')
      .replace(/^      - /, '        ');
    const rawRun = field(normalized, 'run', 8);
    const hasContinuation = mappingBlock(normalized, 'run', 8).split('\n').slice(1)
      .some((line) => line.trim() && !line.trimStart().startsWith('#'));
    // Do not mistake a multiline plain scalar for an allowlisted one-line
    // command; YAML would fold its continuation into the executed shell text.
    const run = hasContinuation && rawRun !== '|' ? '' : rawRun;
    return { source: normalized, name: field(normalized, 'name', 8),
      id: field(normalized, 'id', 8), run,
      uses: field(normalized, 'uses', 8), condition: expression(field(normalized, 'if', 8)) };
  });
}

function checkMutationLock(source, indent, label, group, issues) {
  const block = mappingBlock(source, 'concurrency', indent);
  if (unquote(field(block, 'group', indent + 2)) !== group) {
    issues.push(`${label} must lock ${group} at job level.`);
  }
  if (field(block, 'cancel-in-progress', indent + 2) !== 'false') {
    issues.push(`${label} must not cancel a running mutation.`);
  }
  if (unquote(field(block, 'queue', indent + 2)) !== 'max') {
    issues.push(`${label} must preserve pending mutations with queue: max.`);
  }
}

function checkCanonicalPipeline(source, policy, issues) {
  const jobs = workflowJobs(source);
  const validation = jobs.find((job) => job.id === 'validate');
  const deploy = jobs.find((job) => job.id === policy.job);
  const label = `${policy.name} job ${policy.job}`;
  if (mappingBlock(source, 'concurrency', 0)) {
    issues.push(`${policy.name} must not serialize validation with workflow-level concurrency.`);
  }
  if (!validation || field(validation.source, 'uses', 4) !== './.github/workflows/validate.yml'
    || mappingBlock(validation.source, 'if', 4) || mappingBlock(validation.source, 'concurrency', 4)
    || mappingBlock(validation.source, 'continue-on-error', 4)) {
    issues.push(`${policy.name} validate job must run the reusable production gate without bypasses or a lock.`);
  }
  if (!deploy) {
    issues.push(`${policy.name} must contain deploy job ${policy.job}.`);
    return;
  }
  if (field(deploy.source, 'needs', 4) !== 'validate' || mappingBlock(deploy.source, 'if', 4)
    || mappingBlock(deploy.source, 'continue-on-error', 4)) {
    issues.push(`${label} must depend on successful validate without a bypass.`);
  }
  if (jobEnvironment(deploy.source) !== policy.environment) {
    issues.push(`${label} must bind its deploy job to ${policy.environment}.`);
  }
  checkMutationLock(deploy.source, 4, label, policy.group, issues);

  for (const job of jobs.filter((job) => job.id !== policy.job)) {
    if (PRIVILEGED_VALUE.test(job.source) || REMOTE_MUTATION.test(job.source)) {
      issues.push(`${policy.name} job ${job.id} must not bypass the serialized deploy job.`);
    }
  }

  const steps = jobSteps(deploy.source);
  const freshness = steps.filter((step) => step.id === 'queued-release');
  const guard = freshness[0];
  if (freshness.length !== 1 || steps[1] !== guard || !/^actions\/checkout@/.test(steps[0]?.uses ?? '')
    || steps[0]?.condition || guard?.condition
    || guard?.run !== `node scripts/check-queued-release.mjs --branch=${policy.releaseBranch}`
    || mappingBlock(guard?.source ?? '', 'continue-on-error', 8)) {
    issues.push(`${label} must check the queued release immediately after checkout, before attestation or mutations.`);
  }
  if (!steps.some((step, index) => index > 1
    && (step.run === policy.guard || step.run === '|' && step.source.includes(`\n          ${policy.guard}\n`)))) {
    issues.push(`${label} must run ${policy.guard} after the queued-release check.`);
  }
  for (const step of steps.slice(2)) {
    if (mappingBlock(step.source, 'continue-on-error', 8)) {
      issues.push(`${label} step ${step.name || step.id || step.run || step.uses} must not ignore release failures.`);
    }
    const cleanup = step.condition === 'always()' && step.run === 'rm -f "$ASF_BRAND_CLEARANCE_FILE"'
      && !PRIVILEGED_VALUE.test(step.source);
    const rollback = step.run === 'node scripts/worker-version-rollout.mjs rollback'
      && step.condition === `failure() && ${CURRENT_RELEASE} && steps.deploy-worker.outcome != 'skipped'`;
    if (step.condition !== CURRENT_RELEASE && !cleanup && !rollback) {
      issues.push(`${label} step ${step.name || step.id || step.run || step.uses} must require a current queued release.`);
    }
  }
  for (const command of policy.commands) {
    if (!steps.some((step) => step.run === command && step.condition === CURRENT_RELEASE)) {
      issues.push(`${label} must run ${command} only for a current validated release.`);
    }
  }
}

function workflowJobs(source) {
  const lines = source.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => line === 'jobs:');
  if (jobsIndex < 0) return [];

  const starts = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (match) starts.push({ index, id: match[1] });
  }

  return starts.map((start, index) => ({
    id: start.id,
    source: lines.slice(start.index, starts[index + 1]?.index ?? lines.length).join('\n'),
  }));
}

function jobEnvironment(source) {
  return source.match(/^    environment:\s*(production|development)\s*$/m)?.[1]
    ?? source.match(/^    environment:\s*\n      name:\s*(production|development)\s*$/m)?.[1]
    ?? '';
}

function pushBranches(source) {
  const lines = source.split(/\r?\n/);
  const pushIndex = lines.findIndex((line) => /^  push:\s*$/.test(line));
  if (pushIndex < 0) return [];
  const branchesIndex = lines.findIndex((line, index) => (
    index > pushIndex
    && index < lines.length
    && /^    branches:\s*$/.test(line)
  ));
  if (branchesIndex < 0) return [];

  const branches = [];
  for (let index = branchesIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^      -\s+(.+?)\s*$/);
    if (match) {
      branches.push(match[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (!/^\s*$/.test(lines[index])) break;
  }
  return branches;
}

export function deploymentPolicyIssues({ root = defaultRoot } = {}) {
  const workflowsDir = join(root, '.github', 'workflows');
  const issues = [];
  const workflows = new Map();

  for (const name of readdirSync(workflowsDir).filter((entry) => entry.endsWith('.yml')).sort()) {
    const source = readFileSync(join(workflowsDir, name), 'utf8');
    workflows.set(name, source);
    const expectedEnvironment = name.includes('development') ? 'development' : 'production';
    const workflowLock = mappingBlock(source, 'concurrency', 0);
    if (unquote(field(workflowLock, 'group', 2)) === 'production-worker-mutations') {
      checkMutationLock(source, 0, `${name} shared production lock`, 'production-worker-mutations', issues);
    }

    for (const job of workflowJobs(source)) {
      const lock = mappingBlock(job.source, 'concurrency', 4);
      if (unquote(field(lock, 'group', 6)) === 'production-worker-mutations') {
        checkMutationLock(job.source, 4, `${name} job ${job.id}`, 'production-worker-mutations', issues);
      }
      const privileged = PRIVILEGED_VALUE.test(job.source) || REMOTE_MUTATION.test(job.source);
      if (!privileged) continue;
      const environment = jobEnvironment(job.source);
      if (!environment) {
        issues.push(`${name} job ${job.id} uses deploy credentials or remote mutations without a GitHub environment.`);
      } else if (environment !== expectedEnvironment) {
        issues.push(`${name} job ${job.id} must use ${expectedEnvironment}, not ${environment}.`);
      }
    }
  }

  const canonical = [
    {
      name: 'deploy-production.yml',
      branch: 'main',
      releaseBranch: 'main',
      job: 'deploy',
      group: 'production-worker-mutations',
      environment: 'production',
      guard: 'node scripts/production-deploy-guard.mjs',
      commands: ['npm run deploy:frontend -- --skip-production-check'],
    },
    {
      name: 'deploy-frontend-production.yml',
      branch: null,
      releaseBranch: 'main',
      job: 'deploy-frontend',
      group: 'production-worker-mutations',
      environment: 'production',
      guard: 'node scripts/production-deploy-guard.mjs',
      commands: ['npm run deploy:frontend -- --skip-production-check'],
    },
    {
      name: 'deploy-development.yml',
      branch: 'develop',
      releaseBranch: 'develop',
      job: 'deploy',
      group: 'deploy-development',
      environment: 'development',
      guard: 'node scripts/development-deploy-guard.mjs',
      commands: [
        'node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker',
        'node scripts/deploy-frontend-pages.mjs --target=sandbox --skip-production-check',
      ],
    },
  ];

  for (const policy of canonical) {
    const source = workflows.get(policy.name);
    if (!source) {
      issues.push(`Missing canonical workflow ${policy.name}.`);
      continue;
    }
    if (policy.branch) {
      const branches = pushBranches(source);
      if (branches.length !== 1 || branches[0] !== policy.branch) {
        issues.push(`${policy.name} push trigger must contain only ${policy.branch}; found ${branches.join(', ') || 'none'}.`);
      }
      // A docs-only head can supersede a queued code release. Every new head
      // needs its own deployment run, or skipping the older SHA orphans it.
      const push = mappingBlock(source, 'push', 2);
      if (mappingBlock(push, 'paths', 4) || mappingBlock(push, 'paths-ignore', 4)) {
        issues.push(`${policy.name} must run on every ${policy.branch} push without path filters so a newer head cannot orphan a queued release.`);
      }
    }
    checkCanonicalPipeline(source, policy, issues);
  }

  const runbook = readFileSync(join(root, '.github', 'DEPLOYMENT.md'), 'utf8');
  for (const required of [
    '- Deployment branch: `main` only.',
    '`development` is restricted to `develop`',
  ]) {
    if (!runbook.includes(required)) issues.push(`Deployment runbook is missing policy: ${required}`);
  }

  return issues;
}

export function assertDeploymentPolicy(options) {
  const issues = deploymentPolicyIssues(options);
  if (issues.length === 0) return;
  throw new Error(`Deployment branch policy is incomplete:\n- ${issues.join('\n- ')}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    assertDeploymentPolicy();
    console.log('Deployment branch policy passed: production=main, development=develop.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
