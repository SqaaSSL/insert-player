import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/import-casual-roster-production.yml', import.meta.url), 'utf8');
const workflowDefaults = workflow.slice(0, workflow.indexOf('\njobs:\n'));
const importJob = workflow.slice(workflow.indexOf('\n  import-casual:\n'));

describe('Casual draft release download permissions', () => {
  it('grants draft visibility only to the main production import job', () => {
    expect(workflowDefaults).toMatch(/^permissions:\n  contents: read$/m);
    expect(workflowDefaults).not.toContain('contents: write');
    expect(workflowDefaults).toContain('  workflow_dispatch:');
    expect(workflowDefaults).not.toMatch(/^  (?:push|pull_request|pull_request_target):/m);
    expect(importJob).toMatch(/^    if: github.ref == 'refs\/heads\/main'$/m);
    expect(importJob).toMatch(/^    environment: production$/m);
    expect(importJob).toMatch(/^    permissions:\n(?:      #[^\n]*\n)*      contents: write$/m);
    expect(workflow.match(/^\s+contents: write$/gm)).toHaveLength(1);
    expect(workflow.match(/^  [\w-]+:\s*$/gm)?.filter(line => line.includes('import-casual'))).toHaveLength(1);
  });

  it('does not persist the write-capable token in checkout or publish the draft', () => {
    expect(importJob).toMatch(/uses: actions\/checkout@v6\n        with:\n          persist-credentials: false/);
    expect(importJob).toContain('GH_TOKEN: ${{ github.token }}');
    expect(importJob).toContain('gh release view casual-generation-v1');
    expect(importJob).toContain('gh release download casual-generation-v1');
    expect(importJob).toContain('.isDraft == true');
    expect(importJob).not.toMatch(/\bgh release (?:create|edit|upload|delete)\b|\bgit push\b/);
  });

  it('uses the owned-session wrapper only after offline validation and installs its locked browser dependencies', () => {
    const offline = importJob.indexOf('node scripts/import-casual-roster.mjs');
    const dependencies = importJob.indexOf('npm ci');
    const execute = importJob.indexOf('node scripts/import-casual-with-session.mjs');
    expect(offline).toBeGreaterThan(0);
    expect(dependencies).toBeGreaterThan(offline);
    expect(execute).toBeGreaterThan(dependencies);
    expect(importJob).toContain('npx playwright install --with-deps chromium');
    expect(importJob).toContain('ASF_LAUNCH_SMOKE_PRIMARY_USER_ID: ${{ secrets.ASF_LAUNCH_SMOKE_PRIMARY_USER_ID }}');
    expect(importJob).toContain('"$ASF_ARCADE_ADMIN_CLERK_USER_ID" == "$ASF_LAUNCH_SMOKE_PRIMARY_USER_ID"');
    expect(importJob.slice(execute)).toContain('--execute --confirm=IMPORT_CASUAL_ROSTER_PRODUCTION_V1');
    expect(importJob).not.toMatch(/ASF_(?:ARCADE_ADMIN|CLERK)_JWT|storageState|sign_in_tokens/);
    expect(importJob.slice(importJob.indexOf('uses: actions/upload-artifact'))).not.toMatch(/token|session|browser|task-url/);
  });
});
