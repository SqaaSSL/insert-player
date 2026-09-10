import { auraChallengeUrl, encodeAuraChallenge, type AuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { copyToClipboard } from './communityShare.ts';

export interface AuraChallengeShareData {
  title: string;
  text: string;
  url: string;
}

export type AuraChallengeShareOutcome = 'shared' | 'cancelled' | 'copied' | 'manual';

/** Only the explicitly chosen public name, social score and compatible routine
 * enter this payload. No local character or recording is inferred or attached. */
export function auraChallengeShareUrl(challenge: AuraChallenge, origin: string, apiBase = String(import.meta.env.VITE_API_BASE_URL ?? '')): string {
  // A relative dev proxy cannot serve crawler pages. Keep local play usable,
  // and never carry API query strings, credentials or an arbitrary redirect.
  try {
    const api = new URL(apiBase);
    if (api.protocol === 'https:' && !api.username && !api.password && !api.search && !api.hash
      && (api.pathname === '/' || api.pathname === '')) {
      return new URL(`/challenges/aura/${encodeAuraChallenge(challenge)}`, api.origin).toString();
    }
  } catch { /* No public Worker configured: use the existing local receiver. */ }
  return auraChallengeUrl(challenge, origin);
}

export function auraChallengeShareData(challenge: AuraChallenge, origin: string, apiBase?: string): AuraChallengeShareData {
  return {
    title: `${challenge.score.toLocaleString('en-US')} AURA · Insert Player`,
    text: `${challenge.name} set ${challenge.score.toLocaleString('en-US')} AURA on Insert Player. Can you beat me? Play the same song and routine free. Friendly challenge, not a ranked score.`,
    url: auraChallengeShareUrl(challenge, origin, apiBase),
  };
}

interface AuraChallengeSharePorts {
  share?: (data: AuraChallengeShareData) => Promise<void>;
  copy: (text: string) => Promise<boolean>;
}

function browserPorts(): AuraChallengeSharePorts {
  try {
    return {
      share: typeof navigator.share === 'function' ? data => navigator.share(data) : undefined,
      copy: copyToClipboard,
    };
  } catch { return { copy: copyToClipboard }; }
}

export async function shareAuraChallenge(
  data: AuraChallengeShareData,
  ports: AuraChallengeSharePorts = browserPorts(),
): Promise<AuraChallengeShareOutcome> {
  if (ports.share) {
    try {
      // No awaits before this call: keep the click's native-share activation.
      await ports.share(data);
      return 'shared';
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return 'cancelled';
    }
  }
  try { return await ports.copy(data.url) ? 'copied' : 'manual'; }
  catch { return 'manual'; }
}
