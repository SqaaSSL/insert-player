import { render, type FontLoader } from 'takumi-js';
import pressStart2P from '@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2';
import spaceGrotesk from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2';
import spaceGroteskBold from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2';
import { buildAuraChallengeOgDocument, AURA_CHALLENGE_OG_HEIGHT, AURA_CHALLENGE_OG_WIDTH } from './auraChallengeOgTemplate';
import type { AuraChallengePreview } from './auraChallengePreview';

const FONTS: FontLoader[] = [
  { name: 'Press Start 2P', data: pressStart2P, weight: 400 },
  { name: 'Space Grotesk', data: spaceGrotesk, weight: 400 },
  { name: 'Space Grotesk', data: spaceGroteskBold, weight: 700 },
];

export async function renderAuraChallengeOg(challenge: AuraChallengePreview): Promise<ArrayBuffer> {
  const document = buildAuraChallengeOgDocument(challenge);
  const rendered = await render(document.node, {
    width: AURA_CHALLENGE_OG_WIDTH, height: AURA_CHALLENGE_OG_HEIGHT,
    format: 'png', fonts: FONTS, stylesheets: [document.css], lang: 'en',
  });
  return rendered.slice().buffer as ArrayBuffer;
}
