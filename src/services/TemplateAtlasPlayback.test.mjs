import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEMPLATE_ATLAS_ANIMATION_NAMES, TEMPLATE_ATLAS_VERSION } from './TemplateAtlasContract.ts';
import { TEMPLATE_ATLAS_MANIFEST_SHA256, templateAtlasPlayback, templateAtlasSourcePlanIds } from './TemplateAtlasPlayback.ts';

const assetsUrl = new URL('../../processor/src/templateAtlas/assets/', import.meta.url);
const bytes = readFileSync(new URL('manifest.json', assetsUrl));
const manifest = JSON.parse(bytes.toString('utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

describe('shared playback agrees with the private frozen Template Zero bundle', () => {
  it('pins the exact manifest, generic source inventory and canonical canvas', () => {
    expect(sha256(bytes)).toBe(TEMPLATE_ATLAS_MANIFEST_SHA256);
    expect(manifest.version).toBe(TEMPLATE_ATLAS_VERSION);
    expect(manifest.counts).toEqual({ masters: 131, animations: 20, playbackFrames: 184 });
    expect(manifest.canonical).toEqual({ width: 1536, height: 2048, groundY: 1884 });
    expect(manifest.identityAssetsIncluded).toBe(false);
    expect(manifest.animations.map(animation => animation.name)).toEqual([...TEMPLATE_ATLAS_ANIMATION_NAMES]);
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|\.local\/|upright-white|francisco/i);
  });

  it('matches every one of 184 authored playback positions, FPS and loop flags', () => {
    const referenced = new Set();
    let playbackCount = 0;
    for (const animation of manifest.animations) {
      const shared = templateAtlasPlayback(animation.name);
      expect(shared, animation.name).toEqual({ sequence: animation.sequence, fps: animation.fps, loop: animation.loop });
      const usedAtlasIds = manifest.rookiePacks.filter(pack => pack.cells.some(cell => animation.sequence.includes(cell.masterId)))
        .map(pack => `rookie-two-atlas-v1:${pack.id}`);
      expect(templateAtlasSourcePlanIds('rookie-two-atlas-v1', animation.name), `${animation.name} atlas provenance`).toEqual(usedAtlasIds);
      expect(templateAtlasSourcePlanIds('champion-animation-sheet-v1', animation.name)).toEqual([`champion-animation-sheet-v1:${animation.name}`]);
      playbackCount += shared.sequence.length;
      shared.sequence.forEach(id => referenced.add(id));
    }
    expect(playbackCount).toBe(184);
    expect([...referenced].sort()).toEqual(manifest.masters.map(master => master.id).sort());
    const kick = templateAtlasPlayback('high_kick');
    expect(kick.sequence).toHaveLength(21);
    expect(kick.sequence.slice(9, 12)).toEqual(['master-034', 'master-034', 'master-034']);
    // A consumer cannot accidentally edit the frozen table via a returned array.
    kick.sequence[0] = 'changed-by-test';
    expect(templateAtlasPlayback('high_kick').sequence[0]).toBe('master-026');
  });

  it('verifies actual private PNG bytes and exact two-atlas master coverage', () => {
    const masters = manifest.masters;
    expect(masters).toHaveLength(131);
    expect(new Set(masters.map(master => master.sha256)).size).toBe(131);
    for (const master of masters) {
      expect(master.file).toMatch(/^masters\/master-\d{3}\.png$/);
      const filename = fileURLToPath(new URL(master.file, assetsUrl));
      expect(sha256(readFileSync(filename)), master.id).toBe(master.sha256);
      expect([master.width, master.height]).toEqual([1536, 2048]);
    }
    expect(manifest.rookiePacks.map(pack => pack.id)).toEqual(['two-01', 'two-02']);
    expect(manifest.rookiePacks.map(pack => pack.cells.length)).toEqual([66, 65]);
    expect(manifest.rookiePacks.flatMap(pack => pack.cells.map(cell => cell.masterId))).toEqual(masters.map(master => master.id));
    for (const pack of manifest.rookiePacks) {
      expect(pack.image.file).toMatch(/^rookie\/two-0[12]\.png$/);
      expect(sha256(readFileSync(new URL(pack.image.file, assetsUrl)))).toBe(pack.image.sha256);
      expect(pack.grid).toEqual({ columns: 10, rows: 7 });
    }
  });
});
