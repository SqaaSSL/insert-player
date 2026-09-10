import { auraChallengeUrl, type AuraChallenge } from '../../game/aura/AuraChallenge.ts';
import { copyToClipboard } from './communityShare.ts';

export interface AuraChallengeShareData {
  title: string;
  text: string;
  url: string;
}

export type AuraChallengeShareOutcome = 'shared' | 'cancelled' | 'copied' | 'manual';

/** Only the explicitly chosen public name, social score and compatible routine
 * enter this payload. No local character or recording is inferred or attached. */
export function auraChallengeShareData(challenge: AuraChallenge, origin: string): AuraChallengeShareData {
  return {
    title: 'Your turn · Insert Player Aura',
    text: `${challenge.name} set ${challenge.score.toLocaleString('en-US')} AURA. Can you beat it? Play the same song and routine free. Friendly challenge, not a ranked score.`,
    url: auraChallengeUrl(challenge, origin),
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
