import { hashString } from './auth';
import type { Env } from './types';

/**
 * Headroom derivatives (migration 0049) of a sealed reviewed canonical RAW
 * source. An extra Video move may use one as IMAGE 1 instead of the RAW itself;
 * everything that proves the fighter's sources keeps binding the original.
 */
export interface CanonicalHeadroomSource {
  fighterId: string;
  sourceKind: 'side' | 'crouch';
  rawVersionId: string;
  rawSha256: string;
}

export interface CanonicalHeadroomDerivative {
  blobKey: string;
  sha256: string;
}

const MAX_DERIVATIVE_BYTES = 12 * 1024 * 1024;

export async function findCanonicalHeadroomDerivative(
  env: Env,
  source: CanonicalHeadroomSource,
): Promise<CanonicalHeadroomDerivative | null> {
  const row = await env.DB.prepare(`
    SELECT derived_blob_key, derived_sha256
    FROM canonical_headroom_derivatives
    WHERE fighter_id = ? AND source_kind = ?
      AND source_raw_version_id = ? AND source_raw_sha256 = ?
    LIMIT 1
  `).bind(source.fighterId, source.sourceKind, source.rawVersionId, source.rawSha256)
    .first<{ derived_blob_key: string; derived_sha256: string }>();
  return row ? { blobKey: row.derived_blob_key, sha256: row.derived_sha256 } : null;
}

export async function loadCanonicalHeadroomDerivative(
  env: Env,
  derivative: CanonicalHeadroomDerivative,
): Promise<ArrayBuffer> {
  const object = await env.SPRITES.get(derivative.blobKey);
  if (!object) throw new Error('Canonical headroom derivative is unavailable');
  if (object.size > MAX_DERIVATIVE_BYTES) {
    throw new Error('Canonical headroom derivative exceeds its integrity size limit');
  }
  const bytes = await object.arrayBuffer();
  if (await hashString(bytes) !== derivative.sha256) {
    throw new Error('Canonical headroom derivative failed integrity validation');
  }
  return bytes;
}

/** True when a recorded derivative ties exactly this blob and digest to the sealed RAW. */
export async function isCanonicalHeadroomDerivative(
  env: Env,
  source: CanonicalHeadroomSource,
  candidate: CanonicalHeadroomDerivative,
): Promise<boolean> {
  const derivative = await findCanonicalHeadroomDerivative(env, source);
  return derivative !== null &&
    derivative.blobKey === candidate.blobKey &&
    derivative.sha256 === candidate.sha256;
}
