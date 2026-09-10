import { AURA_CHALLENGE_ASSETS } from './AuraChallengeAssets.ts';
import { validateAuraChallenge, type AuraChallenge } from './AuraChallenge.ts';

const MAX_ASSET_BYTES = 8_000_000;

async function verifiedAsset(key: string, signal: AbortSignal): Promise<Blob> {
  const asset = AURA_CHALLENGE_ASSETS[key];
  if (!asset) throw new Error('Challenge asset unavailable');
  const response = await fetch(asset.url, { signal, credentials: 'same-origin' });
  if (!response.ok || !response.body) throw new Error('Challenge asset unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ASSET_BYTES) throw new Error('Challenge asset exceeded its limit');
      chunks.push(new Uint8Array(next.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const blob = new Blob(chunks, { type: key.startsWith('track:') ? 'audio/mpeg' : 'application/octet-stream' });
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== asset.sha256) throw new Error('Challenge media has changed. Ask for a new challenge.');
  return blob;
}

/** Verify actual public bytes, not merely a mutable URL. The returned music
 * blob is the one the game plays, avoiding a second unverified audio fetch. */
export async function prepareAuraChallengeMusic(challenge: AuraChallenge, signal: AbortSignal): Promise<Blob> {
  if (!validateAuraChallenge(challenge).ok) throw new Error('Incompatible Aura challenge');
  const [music] = await Promise.all([
    verifiedAsset(`track:${challenge.trackId}`, signal),
    verifiedAsset(`stage:${challenge.stageId}`, signal),
  ]);
  return music;
}
