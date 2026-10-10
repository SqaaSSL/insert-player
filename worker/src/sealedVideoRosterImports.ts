import type { ReviewedCanonicalSourceHashes } from './reviewedCanonicalSources';

/**
 * Official Champions whose approved Video set predates generation-job review
 * lineage and was installed from a sealed, hash-pinned import bundle instead.
 * The bundle is the approval record: its six canonical source PNGs and eleven
 * sprite sheets are pinned here byte-for-byte (SHA-256). Each entry must stay
 * identical to its importer contract; videoExtraSourceProof.test.ts enforces it.
 */
export interface SealedVideoRosterImport {
  bundleId: string;
  fighterId: string;
  slug: string;
  sourceHashes: ReviewedCanonicalSourceHashes;
  sprites: Readonly<Record<string, { processedSha256: string; rawSha256: string }>>;
  /**
   * Live successors of a pinned sprite installed before recuration transitions
   * were recorded. They are approved because they are what production serves;
   * each must stay the exact byte pair found live.
   */
  liveSuccessors?: Readonly<Record<string, readonly { processedSha256: string; rawSha256: string }[]>>;
}

const TRUMP_SIDE = {
  processedSha256: '8562266a1d16b0137bce31d07ecc59d46c508cb8b3e28b90c380a7de0b1be400',
  rawSha256: '7d66134eb21a42ca54c2d2205c952204886cb59f69cb35349416359c36ccd2a7',
};

/** scripts/trump-video-roster-production-contract.mjs, activated by PR #104. */
const TRUMP_VIDEO_ROSTER_IMPORT: SealedVideoRosterImport = {
  bundleId: 'donald-trump-video-dense-v1-2026-08-26',
  fighterId: '8555abdb8beeb6e03679474c24be982f',
  slug: 'donald-trump',
  sourceHashes: {
    side: TRUMP_SIDE,
    // The reviewed bundle aliases UPRIGHT to the exact SIDE bytes.
    upright: TRUMP_SIDE,
    crouch: {
      processedSha256: '41c6b6e77ad063f4bae41e94133ea312b779107977c4b34666df296df723656b',
      rawSha256: 'eec0779f6120b9f89fb5fc87d7c3e65e8bd285eb220d52f37466ccdc78069749',
    },
  },
  sprites: {
    idle: {
      processedSha256: '5a846707222a1454d97d187174e4ddfe4ce70eb1fcfff03450e1a7cea795af54',
      rawSha256: '2a6f87dd93ab265ff10c228f844b840feeab94e75de80decd5fbe8fb221b67c8',
    },
    walk: {
      processedSha256: 'd417996560bdf2c843e3822a7dfcc6f4d4f3ae8673f43e5cf4588099ec90f972',
      rawSha256: 'cbd159532f8bbadbf4c92e98ddc8a34e6cd03631680f041bbead584bc688b4b6',
    },
    high_punch: {
      processedSha256: 'c9bd3eb92780ecdca2da2b57d0b9446331821d120a2e132180299e8b7d4aad58',
      rawSha256: '721e1aef16531bbc62625edb7eb3b58cd22789e98ac876e93daa056c13ff9b0e',
    },
    low_punch: {
      processedSha256: '5bdeec4e2865333cf6bf6ca3f28919184300db7ac05d2163b8ecbe4850ccc9a1',
      rawSha256: '2650a3a1d5349ca6aa505b3e1cf6a1573f76f2551fa19e47038ff1ad07479fdf',
    },
    high_kick: {
      processedSha256: 'c711e7f434cafffb21927eb59940f8d74e8ceb86df12b02910eee19014267d3c',
      rawSha256: 'fe38e7ee11eb328c56e8ff461326b058091a8a1fe2882080bd07dec57ae55839',
    },
    low_kick: {
      processedSha256: 'f4b2de8a4eb812dc83569eea7df83660c9e366af057b6aa5461e6cc7bb097469',
      rawSha256: '03c1aa9fe2b9234d3c85b26f0e9189f8092c8111b138e8c2db44baf39ea08abe',
    },
    jump: {
      processedSha256: 'fb56596152ccbb7e97a70857ff0c529f50108c8d52e15da6e61a5274c2d2ca7b',
      rawSha256: '57a4a1e362010e6961deb0d1d816a966fa92a04d85ad1a8ab80401238e9da861',
    },
    crouch: {
      processedSha256: '9969d8a152038942b97a7b5768d8337e242a5b0d5368f04ecf9e0088c0feb21f',
      rawSha256: 'c89ec4638198472c09b7f87f08736ebba02d7f681dac8d7487e9bf904cc0ce3a',
    },
    hit: {
      processedSha256: '451fcda874c2f8f28664a87692c8e968ec9a9691f4a3b8eca45e666959191e7d',
      rawSha256: 'aaa3dddd4287bba2f13882e5b45871518a013bc0272ac43b98ca3e103a7891df',
    },
    ko: {
      processedSha256: '51c24951287494b947bd9035bbde1619b937d5234d599238a5cc6158c26ee704',
      rawSha256: '5e9feab33bdb89fdeef3e49bb173ccf25888e4dc544825862b9420db5264f082',
    },
    victory: {
      processedSha256: 'a811d5ef0b5988bf4c341aac4d2e677877c00659acf8ce7b867519e9ae72b13c',
      rawSha256: '6c87c71cbb6ec80a5cc9309c21e88a5cbe3c86423534c7a826e7a07e4f6f9b98',
    },
  },
  liveSuccessors: {
    // Processing-v6 recut of the bundle idle (sprite version 4a15e06c…,
    // 2026-08-28 14:45 UTC), live since then with no recuration transition.
    idle: [{
      processedSha256: 'd8f27ac23f32d6093f6c58691aaf17801ca8e6beafae4502c14b2de1c8568d05',
      rawSha256: 'ad733cdda5a2a47829004a532ffed39c9f72b35541603b12405c79405eee15e4',
    }],
  },
};

export const SEALED_VIDEO_ROSTER_IMPORTS: readonly SealedVideoRosterImport[] = [TRUMP_VIDEO_ROSTER_IMPORT];

export function sealedVideoRosterImportFor(fighterId: string): SealedVideoRosterImport | null {
  return SEALED_VIDEO_ROSTER_IMPORTS.find((entry) => entry.fighterId === fighterId) ?? null;
}
