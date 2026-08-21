import { apiUrl } from '../../services/ApiClient.ts';
import { PUBLIC_APP_NAME } from '../publicBrand.ts';

export function communityDeepLinkUrl(fighterId: string): string {
  const base = typeof window === 'undefined' ? '/community' : `${window.location.origin}/community`;
  return `${base}?fighter=${encodeURIComponent(fighterId)}`;
}

export function communityFighterUrl(fighterId: string): string {
  const sharePath = `/share/${encodeURIComponent(fighterId)}`;
  const url = apiUrl(sharePath);
  return /^https?:\/\//i.test(url) ? url : communityDeepLinkUrl(fighterId);
}

export type CommunityShareMode = 'native' | 'clipboard' | 'prompt' | 'cancelled';

export interface CommunityShareResult {
  mode: CommunityShareMode;
  url: string;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function shareCommunityFighter(fighterId: string, fighterName?: string): Promise<CommunityShareResult> {
  const url = communityFighterUrl(fighterId);
  const title = fighterName ? `${fighterName} - ${PUBLIC_APP_NAME}` : PUBLIC_APP_NAME;
  const text = fighterName
    ? `Challenge ${fighterName} in ${PUBLIC_APP_NAME}.`
    : `Challenge this ${PUBLIC_APP_NAME} fighter.`;

  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text, url });
      return { mode: 'native', url };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { mode: 'cancelled', url };
      }
    }
  }

  const copied = await copyToClipboard(url);
  return { mode: copied ? 'clipboard' : 'prompt', url };
}
