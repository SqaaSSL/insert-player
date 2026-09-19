import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readImageSize } from './image-dimensions.mjs';
import { SOCIAL_CARD_APPROVED_SHA256, SOCIAL_CARD_SOURCES } from './social-card-inputs.mjs';

const file = path => new URL(`../${path}`, import.meta.url);
const text = path => readFileSync(file(path), 'utf8');
const digest = path => createHash('sha256').update(readFileSync(file(path))).digest('hex');
const imagePath = '/assets/social-card-v12.jpg';

describe('approved photo-to-character social artwork', () => {
  it('ships the exact reviewed JPEG without regenerating it from the old gameplay template', () => {
    expect(SOCIAL_CARD_APPROVED_SHA256).toBe('ea23c4320d2fc8dccc9e7f974a5d23af8e9c9672de880062f46a478d5ffe80ba');
    expect(digest(SOCIAL_CARD_SOURCES[0])).toBe(SOCIAL_CARD_APPROVED_SHA256);
    expect(digest(`public${imagePath}`)).toBe(SOCIAL_CARD_APPROVED_SHA256);
    expect(SOCIAL_CARD_SOURCES).not.toContain('scripts/assets/social-card-gameplay.ts');
  });

  it.each([
    ['public/assets/social-card-v12.jpg', 300_000],
    ['public/assets/social-card-v12.webp', 150_000],
  ])('keeps %s within the social preview dimensions and byte budget', (path, maxBytes) => {
    expect(readImageSize(file(path))).toEqual({ width: 1200, height: 630 });
    expect(statSync(file(path)).size).toBeLessThanOrEqual(maxBytes);
  });

  it('points OG, secure OG and Twitter to the same JPEG with matching alt text', () => {
    const html = text('index.html');
    for (const attribute of ['property="og:image"', 'property="og:image:secure_url"', 'name="twitter:image"']) {
      expect(html).toContain(`${attribute} content="https://insertplayer.ai${imagePath}"`);
    }
    const alt = "Insert Player: a woman's photo becomes the same playable character performing six-seven and a high kick. Your photo. Your Aura.";
    expect(html).toContain(`property="og:image:alt" content="${alt}"`);
    expect(html).toContain(`name="twitter:image:alt" content="${alt}"`);
    expect(html).toContain('property="og:image:type" content="image/jpeg"');
    expect(html).not.toContain('social-card-v8');
    expect(html).not.toContain('social-card-v11');
  });

  it.each([
    '.github/workflows/deploy-production.yml',
    '.github/workflows/deploy-frontend-production.yml',
    '.env.production.example',
    'scripts/apply-public-brand.mjs',
    'scripts/smoke-frontend-live.mjs',
    'scripts/battle-watch-page.mjs',
  ])('keeps the published default consistent in %s', path => {
    expect(text(path)).toContain(imagePath);
    expect(text(path)).not.toContain('/assets/social-card-v8.jpg');
    expect(text(path)).not.toContain('/assets/social-card-v11.jpg');
  });

  it('preserves the previous social cards', () => {
    for (const path of ['public/assets/social-card-v7.jpg', 'public/assets/social-card-v8.jpg', 'public/assets/social-card-v8.webp', 'public/assets/social-card-v11.jpg', 'public/assets/social-card-v11.webp']) {
      expect(statSync(file(path)).size).toBeGreaterThan(0);
    }
    expect(digest('public/assets/social-card-v11.jpg')).toBe('f27111d43d5448e8627cd3435ae1ccd07704db45ac3697ef1b227bcc9bc144c6');
  });

  it('preserves the recovered portrait source instead of generating another face', () => {
    expect(digest('videos/insert-player-launch/assets/generated/player-one-photo-matched-v1.png')).toBe('2fc3c2d7cdb7b013c12564da947d0d1a35d8e9f67d48efe6ff445c9d8abe5605');
  });
});
