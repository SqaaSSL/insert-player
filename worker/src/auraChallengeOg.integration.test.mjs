import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '../node_modules/takumi-js/dist/index.mjs';
import { buildAuraChallengeOgDocument, AURA_CHALLENGE_OG_ART_URL, AURA_CHALLENGE_OG_HEIGHT, AURA_CHALLENGE_OG_WIDTH } from './auraChallengeOgTemplate.ts';

afterEach(() => vi.unstubAllGlobals());

function imageSources(node) {
  if (!node || typeof node !== 'object') return [];
  const children = node.props?.children ?? [];
  return [
    ...(node.type === 'img' ? [node.props.src] : []),
    ...(Array.isArray(children) ? children : [children]).flatMap(imageSources),
  ];
}

function nameText(node) {
  if (!node || typeof node !== 'object') return '';
  const children = node.props?.children ?? [];
  if (node.props?.className?.split(' ').includes('challenger-name')) {
    return children.map(line => line.props.children.join('')).join('');
  }
  return (Array.isArray(children) ? children : [children]).map(nameText).join('');
}

describe('Aura OG image renderer', () => {
  it.each([
    { name: 'Alex <3 & "friends" 😎', score: 12_500 },
    { name: '<img src="https://evil.example">', score: 0 },
    { name: 'W'.repeat(32), score: Number.MAX_SAFE_INTEGER },
    { name: '😎', score: 100 },
  ])('renders branded 1200×630 PNG pixels with bundled game artwork for $name / $score', async ({ name, score }) => {
    const fetch = vi.fn(() => { throw new Error('OG rendering must not fetch remote assets'); });
    vi.stubGlobal('fetch', fetch);
    const font = async (file, name, weight) => {
      const bytes = await readFile(new URL(`../node_modules/@fontsource/${file}`, import.meta.url));
      return { name, weight, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
    const fonts = await Promise.all([
      font('press-start-2p/files/press-start-2p-latin-400-normal.woff2', 'Press Start 2P', 400),
      font('space-grotesk/files/space-grotesk-latin-400-normal.woff2', 'Space Grotesk', 400),
      font('space-grotesk/files/space-grotesk-latin-700-normal.woff2', 'Space Grotesk', 700),
    ]);
    const artwork = await readFile(new URL('./assets/aura-six-seven-og-v2.png', import.meta.url));
    const document = buildAuraChallengeOgDocument({ name, score, difficulty: 'viral' });
    const nodes = JSON.stringify(document.node);
    // A line break may replace whitespace; every chosen character remains text.
    expect(nameText(document.node).replace(/\s/g, '')).toBe(name.replace(/\s/g, ''));
    expect(nodes).toContain(score.toLocaleString('en-US'));
    expect(nodes).toContain('INSERT PLAYER');
    expect(nodes).toContain('insertplayer.ai');
    expect(nodes).toContain('FRIENDLY CHALLENGE');
    expect(imageSources(document.node)).toEqual(['asset://insert-player/aura-six-seven-og-v2']);
    expect(nodes).not.toMatch(/"type":"script"|dangerouslySetInnerHTML/);
    const png = await render(document.node, {
      width: AURA_CHALLENGE_OG_WIDTH, height: AURA_CHALLENGE_OG_HEIGHT,
      format: 'png', fonts, stylesheets: [document.css], lang: 'en', emoji: 'from-font',
      images: { cache: 'auto', allowUrl: () => false, sources: [{ src: AURA_CHALLENGE_OG_ART_URL, data: artwork }] },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dimensions = new DataView(png.buffer, png.byteOffset + 16, 8);
    expect([dimensions.getUint32(0), dimensions.getUint32(4)]).toEqual([1200, 630]);
    expect(png.byteLength).toBeGreaterThan(20_000);
  }, 30_000);
});
