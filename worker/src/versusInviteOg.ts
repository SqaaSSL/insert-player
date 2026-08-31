import type { FontLoader, ImagesInput } from 'takumi-js';
import { render } from 'takumi-js';
import pressStart2P from '@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2';
import spaceGrotesk from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2';
import spaceGroteskBold from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2';
import type { QualityTier } from './types';
import {
  buildVersusInviteOgDocument,
  VERSUS_INVITE_FIGHTER_ASSET_URL,
  VERSUS_INVITE_OG_HEIGHT,
  VERSUS_INVITE_OG_WIDTH,
} from './versusInviteOgTemplate';

const FONTS: FontLoader[] = [
  { name: 'Press Start 2P', data: pressStart2P, weight: 400 },
  { name: 'Space Grotesk', data: spaceGrotesk, weight: 400 },
  { name: 'Space Grotesk', data: spaceGroteskBold, weight: 700 },
];

export async function renderVersusInviteOg(input: {
  inviterName: string;
  fighterName: string;
  qualityTier: QualityTier;
  fighterImage: ArrayBuffer;
}): Promise<ArrayBuffer> {
  const document = buildVersusInviteOgDocument(input);
  const images: ImagesInput = {
    cache: 'auto',
    sources: [{ src: VERSUS_INVITE_FIGHTER_ASSET_URL, data: input.fighterImage }],
  };
  const rendered = await render(document.html.replace(/>\s+</g, '><').trim(), {
    width: VERSUS_INVITE_OG_WIDTH,
    height: VERSUS_INVITE_OG_HEIGHT,
    format: 'png',
    fonts: FONTS,
    images,
    stylesheets: [document.css],
    lang: 'en',
  });
  return rendered.slice().buffer as ArrayBuffer;
}
