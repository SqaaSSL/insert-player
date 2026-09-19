import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checker = readFileSync(join(root, 'scripts/check-production.mjs'), 'utf8');
const start = checker.indexOf('function assertAnonymousRookieTurnstileIsWired()');
const end = checker.indexOf('\nfunction assertHeavyRoutesStayLazy()', start);
if (start < 0 || end < 0) throw new Error('Production guard function could not be located');
const guard = checker.slice(start, end);
const pagePath = join(root, 'src/ui/routes/CreateFighterPage.tsx');
const page = readFileSync(pagePath, 'utf8');

// Exercise the real static production guard, not a second copy of its conditions.
function validate(pageSource) {
  return runInNewContext(`${guard}\nassertAnonymousRookieTurnstileIsWired();`, {
    root,
    join,
    readFileSync: (path, encoding) => path === pagePath ? pageSource : readFileSync(path, encoding),
  }, { timeout: 1_000 });
}

describe('production creation guard with public-figure declaration', () => {
  it('accepts the new declaration without losing existing creation protections', () => {
    expect(() => validate(page)).not.toThrow();
  });

  it.each(['isPublicFigure === null || ', '!turnstileReady || ', '!legalAccepted || ', '!recoveryReady'])
    ('still rejects removing the %s protection', (condition) => {
      expect(page).toContain(condition);
      expect(() => validate(page.replaceAll(condition, ''))).toThrow('Anonymous Rookie Turnstile protection is missing');
    });
});
