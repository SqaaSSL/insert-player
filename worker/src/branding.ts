import type { Env } from './types';
import { stripTrailingSlashes } from './url';

const DEFAULT_PUBLIC_APP_NAME = 'Insert Player';
const DEFAULT_SOCIAL_CARD_PATH = '/assets/social-card.png';

function cleanPublicText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || /replace_me/i.test(text)) return fallback;
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, 80).trim() || fallback;
}

export function publicAppName(env: Env): string {
  return cleanPublicText(env.PUBLIC_APP_NAME, DEFAULT_PUBLIC_APP_NAME);
}

export function publicSocialCardUrl(env: Env): string {
  const path = cleanPublicText(env.PUBLIC_SOCIAL_CARD_PATH, DEFAULT_SOCIAL_CARD_PATH);
  if (/^https:\/\//i.test(path)) return path;
  const origin = stripTrailingSlashes(env.CORS_ORIGIN.split(',')[0]?.trim() ?? '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}
