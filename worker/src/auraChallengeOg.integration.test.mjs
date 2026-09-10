import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { render } from '../node_modules/takumi-js/dist/index.mjs';
import { buildAuraChallengeOgDocument, AURA_CHALLENGE_OG_HEIGHT, AURA_CHALLENGE_OG_WIDTH } from './auraChallengeOgTemplate.ts';

describe('Aura OG image renderer', () => {
  it('renders real branded 1200×630 PNG pixels from local fonts without fetching player media', async () => {
    const font = async (file, name, weight) => {
      const bytes = await readFile(new URL(`../node_modules/@fontsource/${file}`, import.meta.url));
      return { name, weight, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
    const fonts = await Promise.all([
      font('press-start-2p/files/press-start-2p-latin-400-normal.woff2', 'Press Start 2P', 400),
      font('space-grotesk/files/space-grotesk-latin-400-normal.woff2', 'Space Grotesk', 400),
      font('space-grotesk/files/space-grotesk-latin-700-normal.woff2', 'Space Grotesk', 700),
    ]);
    const document = buildAuraChallengeOgDocument({ name: 'Alex <3 & "friends"', score: 12_500, difficulty: 'viral' });
    const nodes = JSON.stringify(document.node);
    expect(nodes).toContain(JSON.stringify('Alex <3 & "friends"'));
    expect(nodes).toContain('12,500');
    expect(nodes).toContain('INSERT PLAYER');
    expect(nodes).toContain('insertplayer.ai');
    expect(nodes).toContain('FRIENDLY SCORE');
    expect(nodes).not.toMatch(/"type":"(?:img|script)"|https?:|dangerouslySetInnerHTML/);
    const png = await render(document.node, {
      width: AURA_CHALLENGE_OG_WIDTH, height: AURA_CHALLENGE_OG_HEIGHT,
      format: 'png', fonts, stylesheets: [document.css], lang: 'en',
    });
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dimensions = new DataView(png.buffer, png.byteOffset + 16, 8);
    expect([dimensions.getUint32(0), dimensions.getUint32(4)]).toEqual([1200, 630]);
    expect(png.byteLength).toBeGreaterThan(20_000);
  }, 30_000);
});
