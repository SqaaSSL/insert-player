import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checker = readFileSync(join(root, 'scripts/check-production.mjs'), 'utf8');
const cloudPath = join(root, 'src/services/CloudFighters.ts');
const rosterPath = join(root, 'src/ui/routes/RosterPage.tsx');
const cloud = readFileSync(cloudPath, 'utf8');
const roster = readFileSync(rosterPath, 'utf8');

function productionGuard(name) {
  const start = checker.indexOf(`function ${name}()`);
  const end = checker.indexOf('\nfunction ', start + 1);
  if (start < 0 || end < 0) throw new Error(`Could not locate production guard ${name}`);
  return checker.slice(start, end);
}

const guards = ['assertCrossDeviceRosterImportIsWired', 'assertLocalCachePreservesSpriteVersions'];

// Evaluate the actual release guards against deliberate regressions, preserving
// all other repository files and the normal production check entry point.
function validate(cloudSource = cloud, rosterSource = roster) {
  return runInNewContext(`${guards.map(productionGuard).join('\n')}\n${guards.map(name => `${name}();`).join('\n')}`, {
    root,
    join,
    readFileSync: (path, encoding) => path === cloudPath ? cloudSource
      : path === rosterPath ? rosterSource : readFileSync(path, encoding),
  }, { timeout: 1_000 });
}

describe('production mode-specific roster import guards', () => {
  it('accepts mode-only downloads while retaining the whole authoritative playable map', () => {
    expect(() => validate()).not.toThrow();
  });

  it('rejects replacing authoritative pointers with only the currently requested game pack', () => {
    expect(() => validate(cloud.replace(
      'const playableRefs = cloudPlayableSpriteRefs(fighter.sprites)',
      'const playableRefs = cloudPlayableSpriteRefs(spriteVersions)',
    ))).toThrow('cross-device cloud roster import/play wiring');
  });

  it.each([
    'const requestedRefs = cloudPlayableSpriteRefs(spriteVersions)',
    'Object.values(requestedRefs).every((ref) =>',
    'resolveFighterModeReadiness(exactPlayableSprites, options.gameMode, fighter)',
    'return sprites.filter((sprite) => needed.has(sprite.animationName))',
    'if (!options.gameMode) return sprites',
    "[...AURA_LOADABLE_ANIMATION_NAMES, 'idle', 'victory', 'ko']",
  ])('still requires the import invariant %s', (snippet) => {
    expect(cloud).toContain(snippet);
    expect(() => validate(cloud.replaceAll(snippet, ''))).toThrow();
  });

  it.each([
    'return withApiRequestTimeout(async (signal) => {',
    'const upgraded = await Promise.all(selected.map(async (fighter) => {',
    'includeSourceAssets: false,',
    'assertFighterReadyForMode(playableSprites, fighter.name, gameMode, cachedMeta)',
  ])('still requires the match preparation invariant %s', (snippet) => {
    expect(roster).toContain(snippet);
    expect(() => validate(cloud, roster.replaceAll(snippet, ''))).toThrow('cross-device cloud roster import/play wiring');
  });
});
