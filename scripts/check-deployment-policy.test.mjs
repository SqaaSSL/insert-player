import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deploymentPolicyIssues } from './check-deployment-policy.mjs';

const roots = [];
const CURRENT = "steps.queued-release.outputs.current == 'true'";
const workflows = [
  { name: 'deploy-production.yml', branch: 'main', environment: 'production', job: 'deploy', group: 'production-worker-mutations' },
  { name: 'deploy-frontend-production.yml', branch: 'main', environment: 'production', job: 'deploy-frontend', group: 'production-worker-mutations' },
  { name: 'deploy-development.yml', branch: 'develop', environment: 'development', job: 'deploy', group: 'deploy-development' },
];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'insert-player-deploy-policy-'));
  roots.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (const [path, source] of Object.entries(files)) writeFileSync(join(root, path), source);
  return root;
}

function canonicalWorkflow({ name, branch, environment, job, group }) {
  const isDevelopment = environment === 'development';
  const pages = isDevelopment
    ? 'node scripts/deploy-frontend-pages.mjs --target=sandbox --skip-production-check'
    : 'npm run deploy:frontend -- --skip-production-check';
  return `on:
${name === 'deploy-frontend-production.yml' ? '  workflow_dispatch:' : `  push:
    branches:
      - ${branch}`}
permissions:
  contents: read
  vulnerability-alerts: read
jobs:
  validate:
    uses: ./.github/workflows/validate.yml
  ${job}:
    needs: validate
    concurrency:
      group: ${group}
      cancel-in-progress: false
      queue: max
    environment:
      name: ${environment}
    env:
      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
    steps:
      - name: Check out repository
        uses: actions/checkout@v6
      - name: Check queued release
        id: queued-release
        run: node scripts/check-queued-release.mjs --branch=${branch}
      - name: Attest source
        if: ${CURRENT}
        run: |
          node scripts/${environment}-deploy-guard.mjs
          echo attested
${isDevelopment ? `      - name: Deploy Worker
        if: ${CURRENT}
        run: node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker
` : ''}      - name: Deploy Pages
        if: ${CURRENT}
        run: ${pages}
${name === 'deploy-production.yml' ? `      - name: Restore Worker
        if: failure() && ${CURRENT} && steps.deploy-worker.outcome != 'skipped'
        run: node scripts/worker-version-rollout.mjs rollback
` : ''}${!isDevelopment ? `      - name: Remove temporary launch files
        if: always()
        env:
          ASF_BRAND_CLEARANCE_FILE: \${{ runner.temp }}/brand-clearance.json
        run: rm -f "$ASF_BRAND_CLEARANCE_FILE"
` : ''}`;
}

function canonicalFiles(overrides = {}) {
  return {
    '.github/DEPLOYMENT.md': '- Deployment branch: `main` only.\n`development` is restricted to `develop`',
    ...Object.fromEntries(workflows.map(workflow => [`.github/workflows/${workflow.name}`, canonicalWorkflow(workflow)])),
    ...overrides,
  };
}

function issuesAfter(workflow, change) {
  return deploymentPolicyIssues({ root: fixture(canonicalFiles({
    [`.github/workflows/${workflow.name}`]: change(canonicalWorkflow(workflow)),
  })) });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('deployment policy check', () => {
  it('accepts independent validation and serialized current-release mutations for all canonical workflows', () => {
    expect(deploymentPolicyIssues({ root: fixture(canonicalFiles()) })).toEqual([]);
  });

  it('rejects a privileged job without an environment', () => {
    const root = fixture(canonicalFiles({
      '.github/workflows/manual-production.yml': `on:\n  workflow_dispatch:\njobs:\n  mutate:\n    env:\n      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: npm run deploy:worker\n`,
    }));
    expect(deploymentPolicyIssues({ root })).toContain(
      'manual-production.yml job mutate uses deploy credentials or remote mutations without a GitHub environment.',
    );
  });

  it('rejects an additional canonical push branch', () => {
    expect(issuesAfter(workflows[0], source => source.replace('      - main', '      - main\n      - feature/demo')))
      .toContain('deploy-production.yml push trigger must contain only main; found main, feature/demo.');
  });

  describe.each(workflows)('$name', workflow => {
    const label = `${workflow.name} job ${workflow.job}`;

    it('rejects workflow-wide serialization even if the deploy job also has a lock', () => {
      const issues = issuesAfter(workflow, source => source.replace('jobs:', `concurrency:\n  group: ${workflow.group}\n  cancel-in-progress: false\n  queue: max\njobs:`));
      expect(issues).toContain(`${workflow.name} must not serialize validation with workflow-level concurrency.`);
    });

    it.each([
      ['missing lock', source => source.replace(/    concurrency:\n(?:      .*\n){3}/, '')],
      ['separate lock', source => source.replace(`group: ${workflow.group}`, 'group: unrelated')],
    ])('rejects %s', (_label, change) => {
      expect(issuesAfter(workflow, change)).toContain(`${label} must lock ${workflow.group} at job level.`);
    });

    it.each(['true', '${{ github.event_name == \'push\' }}'])('rejects cancel-in-progress: %s', value => {
      expect(issuesAfter(workflow, source => source.replace('cancel-in-progress: false', `cancel-in-progress: ${value}`)))
        .toContain(`${label} must not cancel a running mutation.`);
    });

    it.each(['', '      queue: single\n'])('rejects a queue that replaces pending releases: %j', replacement => {
      expect(issuesAfter(workflow, source => source.replace('      queue: max\n', replacement)))
        .toContain(`${label} must preserve pending mutations with queue: max.`);
    });

    it.each([
      ['missing validation', source => source.replace('  validate:\n    uses: ./.github/workflows/validate.yml\n', '')],
      ['different gate', source => source.replace('./.github/workflows/validate.yml', './.github/workflows/unchecked.yml')],
      ['conditional validation', source => source.replace('  validate:', '  validate:\n    if: false')],
      ['ignored validation failure', source => source.replace('  validate:', '  validate:\n    continue-on-error: true')],
      ['validation lock', source => source.replace('  validate:', '  validate:\n    concurrency: release-validation')],
    ])('rejects %s', (_label, change) => {
      expect(issuesAfter(workflow, change)).toContain(`${workflow.name} validate job must run the reusable production gate without bypasses or a lock.`);
    });

    it.each([
      ['missing needs', source => source.replace('    needs: validate\n', '')],
      ['another dependency', source => source.replace('    needs: validate', '    needs: unchecked')],
      ['always deployment', source => source.replace('    needs: validate', '    needs: validate\n    if: always()')],
      ['ignored deploy failure', source => source.replace('    needs: validate', '    needs: validate\n    continue-on-error: true')],
    ])('rejects %s', (_label, change) => {
      expect(issuesAfter(workflow, change)).toContain(`${label} must depend on successful validate without a bypass.`);
    });

    it.each([
      ['missing freshness check', source => source.replace(/      - name: Check queued release\n(?:        .*\n){2}/, '')],
      ['wrong branch', source => source.replace(`--branch=${workflow.branch}`, '--branch=feature/demo')],
      ['conditional freshness check', source => source.replace('        id: queued-release', '        id: queued-release\n        if: false')],
      ['ignored freshness failure', source => source.replace('        id: queued-release', '        id: queued-release\n        continue-on-error: true')],
      ['pre-check mutation', source => source.replace('      - name: Check queued release', '      - run: npm run deploy:worker\n      - name: Check queued release')],
      ['duplicate freshness id', source => source.replace('      - name: Attest source', `      - id: queued-release\n        run: node scripts/check-queued-release.mjs --branch=${workflow.branch}\n      - name: Attest source`)],
    ])('rejects %s', (_label, change) => {
      expect(issuesAfter(workflow, change)).toContain(`${label} must check the queued release immediately after checkout, before attestation or mutations.`);
    });

    it.each(['', 'always()', `${CURRENT} || true`, "steps.queued-release.outputs.current != 'false'"])
      ('rejects unsafe mutation condition: %j', condition => {
        const issues = issuesAfter(workflow, source => source.replace(`      - name: Deploy Pages\n        if: ${CURRENT}\n`,
          `      - name: Deploy Pages\n${condition ? `        if: ${condition}\n` : ''}`));
        expect(issues).toContain(`${label} step Deploy Pages must require a current queued release.`);
      });

    it('rejects a mutation hidden in an unconditional cleanup step', () => {
      const issues = issuesAfter(workflow, source => `${source}      - name: Cleanup\n        if: always()\n        run: npm run deploy:worker\n`);
      expect(issues).toContain(`${label} step Cleanup must require a current queued release.`);
    });

    it('requires current-release conditions for setup as well as mutation steps', () => {
      const issues = issuesAfter(workflow, source => `${source}      - name: Set up Node\n        uses: actions/setup-node@v6\n`);
      expect(issues).toContain(`${label} step Set up Node must require a current queued release.`);
    });

    it('rejects moving credentials to an unlocked sibling job', () => {
      const issues = issuesAfter(workflow, source => `${source}  bypass:\n    environment: ${workflow.environment}\n    env:\n      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: npm run deploy:frontend\n`);
      expect(issues).toContain(`${workflow.name} job bypass must not bypass the serialized deploy job.`);
    });

    it('requires the attestation inside the guarded deploy job', () => {
      const issues = issuesAfter(workflow, source => source.replace(`          node scripts/${workflow.environment}-deploy-guard.mjs\n`, '')
        + `  decoy:\n    steps:\n      - run: node scripts/${workflow.environment}-deploy-guard.mjs\n`);
      expect(issues).toContain(`${label} must run node scripts/${workflow.environment}-deploy-guard.mjs after the queued-release check.`);
    });

    it('rejects re-running production validation during Pages mutation', () => {
      const issues = issuesAfter(workflow, source => source.replace('deploy-frontend-pages.mjs --target=sandbox --skip-production-check', 'deploy-frontend-pages.mjs --target=sandbox')
        .replace('npm run deploy:frontend -- --skip-production-check', 'npm run deploy:frontend'));
      expect(issues.some(issue => issue.includes('must run') && issue.includes('skip-production-check'))).toBe(true);
    });
  });

  it('rejects removing freshness from the failure rollback', () => {
    const issues = issuesAfter(workflows[0], source => source.replace(`failure() && ${CURRENT} &&`, 'failure() &&'));
    expect(issues).toContain('deploy-production.yml job deploy step Restore Worker must require a current queued release.');
  });

  it('does not allow attestation failures to be ignored', () => {
    const issues = issuesAfter(workflows[0], source => source.replace('      - name: Attest source',
      '      - name: Attest source\n        continue-on-error: true'));
    expect(issues).toContain('deploy-production.yml job deploy step Attest source must not ignore release failures.');
  });

  it('rejects a folded mutation appended to the allowlisted cleanup command', () => {
    const issues = issuesAfter(workflows[0], source => source.replace('run: rm -f "$ASF_BRAND_CLEARANCE_FILE"',
      'run: rm -f "$ASF_BRAND_CLEARANCE_FILE"\n          && npm run deploy:worker'));
    expect(issues).toContain('deploy-production.yml job deploy step Remove temporary launch files must require a current queued release.');
  });

  it('rejects duplicated validation inside the development Worker mutation', () => {
    const issues = issuesAfter(workflows[2], source => source.replace(
      'node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker', 'npm run config:sandbox'));
    expect(issues).toContain('deploy-development.yml job deploy must run node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker only for a current validated release.');
  });

  it('allows explicit GitHub expression wrappers on current-release conditions', () => {
    const issues = issuesAfter(workflows[1], source => source.replaceAll(`if: ${CURRENT}`, `if: \${{ ${CURRENT} }}`));
    expect(issues).toEqual([]);
  });

  it.each([
    ['absent queue', '  cancel-in-progress: false\n'],
    ['lossy queue', '  cancel-in-progress: false\n  queue: single\n'],
    ['cancellation', '  cancel-in-progress: true\n  queue: max\n'],
  ])('rejects %s in another workflow sharing the production mutation lock', (_label, lockFields) => {
    const issues = deploymentPolicyIssues({ root: fixture(canonicalFiles({
      '.github/workflows/manual-production.yml': `on:\n  workflow_dispatch:\nconcurrency:\n  group: production-worker-mutations\n${lockFields}jobs:\n  manual:\n    environment: production\n    steps:\n      - run: npm run deploy:worker\n`,
    })) });
    expect(issues.some(issue => issue.startsWith('manual-production.yml shared production lock'))).toBe(true);
  });

  it('allows another protected manual workflow to share the lossless production queue', () => {
    const issues = deploymentPolicyIssues({ root: fixture(canonicalFiles({
      '.github/workflows/manual-production.yml': `on:\n  workflow_dispatch:\nconcurrency:\n  group: production-worker-mutations\n  cancel-in-progress: false\n  queue: max\njobs:\n  manual:\n    environment: production\n    steps:\n      - run: npm run deploy:worker\n`,
    })) });
    expect(issues).toEqual([]);
  });
});
