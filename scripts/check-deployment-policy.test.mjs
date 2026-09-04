import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deploymentPolicyIssues } from './check-deployment-policy.mjs';

const roots = [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'insert-player-deploy-policy-'));
  roots.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (const [path, source] of Object.entries(files)) {
    writeFileSync(join(root, path), source);
  }
  return root;
}

function canonicalFiles(overrides = {}) {
  return {
    '.github/DEPLOYMENT.md': '- Deployment branch: `main` only.\n`development` is restricted to `develop`',
    '.github/workflows/deploy-production.yml': `on:\n  push:\n    branches:\n      - main\njobs:\n  deploy:\n    environment: production\n    env:\n      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: node scripts/production-deploy-guard.mjs\n`,
    '.github/workflows/deploy-frontend-production.yml': `on:\n  workflow_dispatch:\njobs:\n  deploy:\n    environment:\n      name: production\n    env:\n      ACCOUNT: \${{ vars.CLOUDFLARE_ACCOUNT_ID }}\n    steps:\n      - run: node scripts/production-deploy-guard.mjs\n`,
    '.github/workflows/deploy-development.yml': `on:\n  push:\n    branches:\n      - develop\njobs:\n  validate:\n    uses: ./.github/workflows/validate.yml\n  deploy:\n    needs: validate\n    environment:\n      name: development\n    env:\n      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: node scripts/development-deploy-guard.mjs\n      - run: node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker\n      - run: node scripts/deploy-frontend-pages.mjs --target=sandbox --skip-production-check\n`,
    ...overrides,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('deployment policy check', () => {
  it('accepts the two canonical protected deployment branches', () => {
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
    const root = fixture(canonicalFiles({
      '.github/workflows/deploy-production.yml': `on:\n  push:\n    branches:\n      - main\n      - feature/demo\njobs:\n  deploy:\n    environment: production\n    env:\n      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: node scripts/production-deploy-guard.mjs\n`,
    }));
    expect(deploymentPolicyIssues({ root }).some((issue) => (
      issue.includes('push trigger must contain only main')
    ))).toBe(true);
  });

  it('rejects a development deploy that can bypass reusable validation', () => {
    const root = fixture(canonicalFiles({
      '.github/workflows/deploy-development.yml': `on:\n  push:\n    branches:\n      - develop\njobs:\n  validate:\n    uses: ./.github/workflows/validate.yml\n  deploy:\n    environment:\n      name: development\n    env:\n      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: node scripts/development-deploy-guard.mjs\n      - run: node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker\n`,
    }));
    expect(deploymentPolicyIssues({ root })).toContain(
      'deploy-development.yml deploy job must depend on validate.',
    );
  });

  it('rejects duplicated production checks inside the development mutation job', () => {
    const root = fixture(canonicalFiles({
      '.github/workflows/deploy-development.yml': `on:\n  push:\n    branches:\n      - develop\njobs:\n  validate:\n    uses: ./.github/workflows/validate.yml\n  deploy:\n    needs: validate\n    environment:\n      name: development\n    env:\n      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: node scripts/development-deploy-guard.mjs\n      - run: npm run config:sandbox\n`,
    }));
    expect(deploymentPolicyIssues({ root })).toContain(
      'deploy-development.yml deploy job must run node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker.',
    );
  });

  it('rejects duplicated production checks inside the development Pages job', () => {
    const root = fixture(canonicalFiles({
      '.github/workflows/deploy-development.yml': `on:\n  push:\n    branches:\n      - develop\njobs:\n  validate:\n    uses: ./.github/workflows/validate.yml\n  deploy:\n    needs: validate\n    environment:\n      name: development\n    env:\n      TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:\n      - run: node scripts/development-deploy-guard.mjs\n      - run: node scripts/apply-sandbox-config.mjs --require-complete --skip-production-check --deploy-worker\n      - run: npm run deploy:frontend:sandbox\n`,
    }));
    expect(deploymentPolicyIssues({ root })).toContain(
      'deploy-development.yml deploy job must run node scripts/deploy-frontend-pages.mjs --target=sandbox --skip-production-check.',
    );
  });
});
