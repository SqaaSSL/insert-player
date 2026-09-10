import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PRIVILEGED_VALUE = /\$\{\{\s*(?:secrets|vars)\.[A-Za-z0-9_]+\s*\}\}/;
const REMOTE_MUTATION = /(?:\bwrangler\b[^\n]*(?:deploy|rollback|delete|secret|d1|r2|pages|versions)|npm run (?:config:|deploy:|db:migrate))/;

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

    for (const job of workflowJobs(source)) {
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
      environment: 'production',
      guard: 'node scripts/production-deploy-guard.mjs',
    },
    {
      name: 'deploy-frontend-production.yml',
      branch: null,
      environment: 'production',
      guard: 'node scripts/production-deploy-guard.mjs',
    },
    {
      name: 'deploy-development.yml',
      branch: 'develop',
      environment: 'development',
      guard: 'node scripts/development-deploy-guard.mjs',
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
    }
    if (!source.includes(policy.guard)) {
      issues.push(`${policy.name} must run ${policy.guard}.`);
    }
    if (!workflowJobs(source).some((job) => jobEnvironment(job.source) === policy.environment)) {
      issues.push(`${policy.name} must bind its deploy job to ${policy.environment}.`);
    }
  }

  const developmentSource = workflows.get('deploy-development.yml');
  if (developmentSource) {
    const developmentJobs = workflowJobs(developmentSource);
    const validationJob = developmentJobs.find((job) => job.id === 'validate');
    const deployJob = developmentJobs.find((job) => job.id === 'deploy');
    const sandboxDeployCommand = 'node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker';
    const sandboxPagesDeployCommand = 'node scripts/deploy-frontend-pages.mjs --target=sandbox --skip-production-check';

    if (!validationJob?.source.includes('uses: ./.github/workflows/validate.yml')) {
      issues.push('deploy-development.yml validate job must use the reusable production gate.');
    }
    if (!deployJob || !/^    needs: validate$/m.test(deployJob.source)) {
      issues.push('deploy-development.yml deploy job must depend on validate.');
    }
    if (!deployJob?.source.includes(sandboxDeployCommand)) {
      issues.push(`deploy-development.yml deploy job must run ${sandboxDeployCommand}.`);
    }
    if (!deployJob?.source.includes(sandboxPagesDeployCommand)) {
      issues.push(`deploy-development.yml deploy job must run ${sandboxPagesDeployCommand}.`);
    }
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
