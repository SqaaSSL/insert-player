import { render, type FontLoader, type ImagesInput } from 'takumi-js';
import pressStart2P from '@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2';
import spaceGrotesk from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2';
import spaceGroteskBold from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2';
import auraArtwork from './assets/aura-six-seven-og-v2.png';
import { buildAuraChallengeOgDocument, AURA_CHALLENGE_OG_ART_URL, AURA_CHALLENGE_OG_HEIGHT, AURA_CHALLENGE_OG_WIDTH } from './auraChallengeOgTemplate';
import type { AuraChallengePreview } from './auraChallengePreview';

const FONTS: FontLoader[] = [
  { name: 'Press Start 2P', data: pressStart2P, weight: 400 },
  { name: 'Space Grotesk', data: spaceGrotesk, weight: 400 },
  { name: 'Space Grotesk', data: spaceGroteskBold, weight: 700 },
];

export async function renderAuraChallengeOg(challenge: AuraChallengePreview): Promise<ArrayBuffer> {
  const document = buildAuraChallengeOgDocument(challenge);
  // Reviewed game artwork ships with the Worker. Rendering a shared score
  // never fetches a player's media or depends on frontend deployment order.
  const images: ImagesInput = {
    cache: 'auto',
    sources: [{ src: AURA_CHALLENGE_OG_ART_URL, data: auraArtwork }],
    allowUrl: () => false,
  };
  const rendered = await render(document.node, {
    width: AURA_CHALLENGE_OG_WIDTH, height: AURA_CHALLENGE_OG_HEIGHT,
    format: 'png', fonts: FONTS, images, stylesheets: [document.css], lang: 'en',
    // Keep emoji in chosen names as text instead of fetching remote Twemoji.
    emoji: 'from-font',
  });
  return rendered.slice().buffer as ArrayBuffer;
}
