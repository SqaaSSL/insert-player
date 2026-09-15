import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function routeSources(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return routeSources(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
    if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) return [];
    return [{ name: `${prefix}${entry.name}`, source: readFileSync(new URL(entry.name, directory), 'utf8') }];
  });
}

const sources = [
  ...routeSources(new URL('./', import.meta.url), 'routes/'),
  ...routeSources(new URL('../pages/', import.meta.url), 'pages/'),
];

describe('Public creation flow visibility', () => {
  it.each(sources)('$name does not import or mount the legacy internal picker', ({ source }) => {
    expect(source).not.toMatch(/\b(?:from\s*|import\s*\(?\s*)['"][^'"]*CreationFlowPicker(?:\.tsx?)?['"]/);
    expect(source).not.toMatch(/<CreationFlowPicker\b/);
  });

  it('does not expose legacy pipeline labels in the creation summary', () => {
    const source = readFileSync(new URL('./CreateFighterPage.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('Original flow');
    expect(source).not.toContain('Video flow');
  });
});
