import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const TRUMP_VIDEO_ROSTER_CONTRACT = deepFreeze({
  schemaVersion: 1,
  bundleId: 'donald-trump-video-dense-v1-2026-08-26',
  fighter: {
    id: '8555abdb8beeb6e03679474c24be982f',
    slug: 'donald-trump',
    name: 'Donald Trump',
    photoHash: 'b8cdec38c5a7e8042acd2a095336a2a5b3255bf8771aedf7634860129af4c476',
    qualityTier: 'champion',
  },
  animationFormat: 'video-dense-v1',
  processingVersion: 5,
  sprites: [
    {
      animationName: 'idle',
      file: 'sprites/idle.png',
      rawFile: 'sprites/raw/idle.png',
      sha256: '5a846707222a1454d97d187174e4ddfe4ce70eb1fcfff03450e1a7cea795af54',
      rawSha256: '2a6f87dd93ab265ff10c228f844b840feeab94e75de80decd5fbe8fb221b67c8',
      sizeBytes: 65648,
      rawSizeBytes: 61499,
      sheetWidth: 1536,
      sheetHeight: 256,
      rawSheetWidth: 1536,
      rawSheetHeight: 256,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 8,
    },
    {
      animationName: 'walk',
      file: 'sprites/walk.png',
      rawFile: 'sprites/raw/walk.png',
      sha256: 'd417996560bdf2c843e3822a7dfcc6f4d4f3ae8673f43e5cf4588099ec90f972',
      rawSha256: 'cbd159532f8bbadbf4c92e98ddc8a34e6cd03631680f041bbead584bc688b4b6',
      sizeBytes: 423831,
      rawSizeBytes: 3347597,
      sheetWidth: 1536,
      sheetHeight: 512,
      rawSheetWidth: 3072,
      rawSheetHeight: 3072,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 12,
    },
    {
      animationName: 'high_punch',
      file: 'sprites/high_punch.png',
      rawFile: 'sprites/raw/high_punch.png',
      sha256: 'c9bd3eb92780ecdca2da2b57d0b9446331821d120a2e132180299e8b7d4aad58',
      rawSha256: '721e1aef16531bbc62625edb7eb3b58cd22789e98ac876e93daa056c13ff9b0e',
      sizeBytes: 318655,
      rawSizeBytes: 2735885,
      sheetWidth: 1536,
      sheetHeight: 512,
      rawSheetWidth: 3072,
      rawSheetHeight: 3072,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 11,
    },
    {
      animationName: 'low_punch',
      file: 'sprites/low_punch.png',
      rawFile: 'sprites/raw/low_punch.png',
      sha256: '5bdeec4e2865333cf6bf6ca3f28919184300db7ac05d2163b8ecbe4850ccc9a1',
      rawSha256: '2650a3a1d5349ca6aa505b3e1cf6a1573f76f2551fa19e47038ff1ad07479fdf',
      sizeBytes: 472894,
      rawSizeBytes: 3960209,
      sheetWidth: 1536,
      sheetHeight: 512,
      rawSheetWidth: 3072,
      rawSheetHeight: 4096,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 13,
    },
    {
      animationName: 'high_kick',
      file: 'sprites/high_kick.png',
      rawFile: 'sprites/raw/high_kick.png',
      sha256: 'c711e7f434cafffb21927eb59940f8d74e8ceb86df12b02910eee19014267d3c',
      rawSha256: 'fe38e7ee11eb328c56e8ff461326b058091a8a1fe2882080bd07dec57ae55839',
      sizeBytes: 1068601,
      rawSizeBytes: 9755861,
      sheetWidth: 1536,
      sheetHeight: 768,
      rawSheetWidth: 3072,
      rawSheetHeight: 6144,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 23,
    },
    {
      animationName: 'low_kick',
      file: 'sprites/low_kick.png',
      rawFile: 'sprites/raw/low_kick.png',
      sha256: 'f4b2de8a4eb812dc83569eea7df83660c9e366af057b6aa5461e6cc7bb097469',
      rawSha256: '03c1aa9fe2b9234d3c85b26f0e9189f8092c8111b138e8c2db44baf39ea08abe',
      sizeBytes: 642839,
      rawSizeBytes: 4977419,
      sheetWidth: 1536,
      sheetHeight: 768,
      rawSheetWidth: 3072,
      rawSheetHeight: 5120,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 17,
    },
    {
      animationName: 'jump',
      file: 'sprites/jump.png',
      rawFile: 'sprites/raw/jump.png',
      sha256: 'fb56596152ccbb7e97a70857ff0c529f50108c8d52e15da6e61a5274c2d2ca7b',
      rawSha256: '57a4a1e362010e6961deb0d1d816a966fa92a04d85ad1a8ab80401238e9da861',
      sizeBytes: 272537,
      rawSizeBytes: 2172415,
      sheetWidth: 1536,
      sheetHeight: 256,
      rawSheetWidth: 3072,
      rawSheetHeight: 2048,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 8,
    },
    {
      animationName: 'crouch',
      file: 'sprites/crouch.png',
      rawFile: 'sprites/raw/crouch.png',
      sha256: '9969d8a152038942b97a7b5768d8337e242a5b0d5368f04ecf9e0088c0feb21f',
      rawSha256: 'c89ec4638198472c09b7f87f08736ebba02d7f681dac8d7487e9bf904cc0ce3a',
      sizeBytes: 362178,
      rawSizeBytes: 3313572,
      sheetWidth: 1152,
      sheetHeight: 256,
      rawSheetWidth: 3072,
      rawSheetHeight: 2048,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 6,
    },
    {
      animationName: 'hit',
      file: 'sprites/hit.png',
      rawFile: 'sprites/raw/hit.png',
      sha256: '451fcda874c2f8f28664a87692c8e968ec9a9691f4a3b8eca45e666959191e7d',
      rawSha256: 'aaa3dddd4287bba2f13882e5b45871518a013bc0272ac43b98ca3e103a7891df',
      sizeBytes: 233638,
      rawSizeBytes: 1797473,
      sheetWidth: 1152,
      sheetHeight: 256,
      rawSheetWidth: 3072,
      rawSheetHeight: 2048,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 6,
    },
    {
      animationName: 'ko',
      file: 'sprites/ko.png',
      rawFile: 'sprites/raw/ko.png',
      sha256: '51c24951287494b947bd9035bbde1619b937d5234d599238a5cc6158c26ee704',
      rawSha256: '5e9feab33bdb89fdeef3e49bb173ccf25888e4dc544825862b9420db5264f082',
      sizeBytes: 386687,
      rawSizeBytes: 2723104,
      sheetWidth: 1536,
      sheetHeight: 512,
      rawSheetWidth: 3072,
      rawSheetHeight: 3072,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 12,
    },
    {
      animationName: 'victory',
      file: 'sprites/victory.png',
      rawFile: 'sprites/raw/victory.png',
      sha256: 'a811d5ef0b5988bf4c341aac4d2e677877c00659acf8ce7b867519e9ae72b13c',
      rawSha256: '6c87c71cbb6ec80a5cc9309c21e88a5cbe3c86423534c7a826e7a07e4f6f9b98',
      sizeBytes: 461597,
      rawSizeBytes: 3498363,
      sheetWidth: 1536,
      sheetHeight: 512,
      rawSheetWidth: 3072,
      rawSheetHeight: 3072,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 12,
    },
  ],
  sources: [
    {
      kind: 'original',
      responseKey: 'original',
      hashKey: 'original',
      file: 'sources/original.png',
      sha256: 'b8cdec38c5a7e8042acd2a095336a2a5b3255bf8771aedf7634860129af4c476',
      sizeBytes: 5440297,
      width: 1583,
      height: 2048,
    },
    {
      kind: 'side',
      responseKey: 'side',
      hashKey: 'side',
      file: 'sources/side.png',
      sha256: '8562266a1d16b0137bce31d07ecc59d46c508cb8b3e28b90c380a7de0b1be400',
      sizeBytes: 3937478,
      width: 1776,
      height: 2368,
    },
    {
      kind: 'side_raw',
      responseKey: 'sideRaw',
      hashKey: 'side_raw',
      file: 'sources/side_raw.png',
      sha256: '7d66134eb21a42ca54c2d2205c952204886cb59f69cb35349416359c36ccd2a7',
      sizeBytes: 787831,
      width: 1776,
      height: 2368,
    },
    {
      kind: 'upright',
      responseKey: 'upright',
      hashKey: 'upright',
      file: 'sources/upright.png',
      sha256: '8562266a1d16b0137bce31d07ecc59d46c508cb8b3e28b90c380a7de0b1be400',
      sizeBytes: 3937478,
      width: 1776,
      height: 2368,
    },
    {
      kind: 'upright_raw',
      responseKey: 'uprightRaw',
      hashKey: 'upright_raw',
      file: 'sources/upright_raw.png',
      sha256: '7d66134eb21a42ca54c2d2205c952204886cb59f69cb35349416359c36ccd2a7',
      sizeBytes: 787831,
      width: 1776,
      height: 2368,
    },
    {
      kind: 'crouch',
      responseKey: 'crouch',
      hashKey: 'crouch',
      file: 'sources/crouch.png',
      sha256: '41c6b6e77ad063f4bae41e94133ea312b779107977c4b34666df296df723656b',
      sizeBytes: 405048,
      width: 816,
      height: 1104,
    },
    {
      kind: 'crouch_raw',
      responseKey: 'crouchRaw',
      hashKey: 'crouch_raw',
      file: 'sources/crouch_raw.png',
      sha256: 'eec0779f6120b9f89fb5fc87d7c3e65e8bd285eb220d52f37466ccdc78069749',
      sizeBytes: 338636,
      width: 816,
      height: 1104,
    },
  ],
  provenance: [
    {
      kind: 'batch-state',
      file: 'provenance/batch-state.json',
      sha256: '3773dd9516dfb1e926a5cc2feb977e2fadbcc19de6c5e0b82b2996390b3a9500',
    },
    {
      kind: 'qa-manifest',
      file: 'provenance/qa-manifest.json',
      sha256: '465c4d93c52edf2943ee81bef5bfdd218cbcc98c4d8fd1331851de3d65e949f7',
    },
    {
      kind: 'high-kick-approval',
      file: 'provenance/high-kick-approval.json',
      sha256: '699ec34f0ce5120d4105b7319f776640ed68a296661bd4b34006560ad492d320',
    },
    {
      kind: 'high-kick-extraction-report',
      file: 'provenance/high-kick-extraction-report.json',
      sha256: '77682fff693c928246dbf9253e3298cf4272cb622f711b1845515d499154d820',
    },
  ],
});

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function contractSha256(contract = TRUMP_VIDEO_ROSTER_CONTRACT) {
  return sha256(Buffer.from(canonicalJson(contract), 'utf8'));
}

export function readPngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Expected a PNG file with a valid signature.');
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG is missing its leading IHDR chunk.');
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

export function validatePngAssetBytes(bytes, {
  label,
  sha256: expectedSha256,
  sizeBytes,
  width,
  height,
}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const digest = sha256(buffer);
  if (digest !== expectedSha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, received ${digest}.`);
  }
  if (buffer.length !== sizeBytes) {
    throw new Error(`${label} size mismatch: expected ${sizeBytes}, received ${buffer.length}.`);
  }
  const dimensions = readPngDimensions(buffer);
  if (dimensions.width !== width || dimensions.height !== height) {
    throw new Error(
      `${label} dimensions mismatch: expected ${width}x${height}, `
      + `received ${dimensions.width}x${dimensions.height}.`,
    );
  }
  return { ...dimensions, sha256: digest, sizeBytes: buffer.length };
}

export function validateSpriteBytes(bytes, sprite) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const validated = validatePngAssetBytes(buffer, {
    label: sprite.animationName,
    sha256: sprite.sha256,
    sizeBytes: sprite.sizeBytes,
    width: sprite.sheetWidth,
    height: sprite.sheetHeight,
  });
  if (sprite.sheetWidth % sprite.frameWidth !== 0 || sprite.sheetHeight % sprite.frameHeight !== 0) {
    throw new Error(`${sprite.animationName} sheet dimensions do not align to its frame dimensions.`);
  }
  const capacity = (sprite.sheetWidth / sprite.frameWidth) * (sprite.sheetHeight / sprite.frameHeight);
  if (capacity < sprite.frameCount) {
    throw new Error(`${sprite.animationName} declares ${sprite.frameCount} frames but its sheet holds only ${capacity}.`);
  }
  return validated;
}

export function validateRawSpriteBytes(bytes, sprite) {
  return validatePngAssetBytes(bytes, {
    label: `${sprite.animationName} raw`,
    sha256: sprite.rawSha256,
    sizeBytes: sprite.rawSizeBytes,
    width: sprite.rawSheetWidth,
    height: sprite.rawSheetHeight,
  });
}

export function validateSourceBytes(bytes, source) {
  return validatePngAssetBytes(bytes, {
    label: `${source.kind} source`,
    sha256: source.sha256,
    sizeBytes: source.sizeBytes,
    width: source.width,
    height: source.height,
  });
}

function assertPlainExact(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} does not match the sealed production contract.`);
  }
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link or special file.`);
  }
}

function listRelativeFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle contains a symbolic link: ${relative(root, path)}.`);
    if (entry.isDirectory()) files.push(...listRelativeFiles(path, root));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    else throw new Error(`Bundle contains a special file: ${relative(root, path)}.`);
  }
  return files.sort();
}

export function expectedBundleManifest(contract = TRUMP_VIDEO_ROSTER_CONTRACT) {
  return {
    schemaVersion: 1,
    bundleId: contract.bundleId,
    contractSha256: contractSha256(contract),
    contract,
  };
}

export function validateBundleDirectory(
  bundleDirectory,
  { contract = TRUMP_VIDEO_ROSTER_CONTRACT } = {},
) {
  const root = resolve(bundleDirectory);
  const manifestPath = join(root, 'manifest.json');
  assertRegularFile(manifestPath, 'Bundle manifest');
  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Bundle manifest is not valid JSON.');
  }
  assertPlainExact(manifest, expectedBundleManifest(contract), 'Bundle manifest');

  const expectedFiles = [
    'manifest.json',
    ...contract.sprites.map((sprite) => sprite.file),
    ...contract.sprites.map((sprite) => sprite.rawFile),
    ...contract.sources.map((source) => source.file),
    ...contract.provenance.map((entry) => entry.file),
  ].sort();
  assertPlainExact(listRelativeFiles(root), expectedFiles, 'Bundle file list');

  const spriteBytes = new Map();
  const rawSpriteBytes = new Map();
  for (const sprite of contract.sprites) {
    const path = join(root, sprite.file);
    assertRegularFile(path, `${sprite.animationName} sprite`);
    const bytes = readFileSync(path);
    validateSpriteBytes(bytes, sprite);
    spriteBytes.set(sprite.animationName, bytes);
    const rawPath = join(root, sprite.rawFile);
    assertRegularFile(rawPath, `${sprite.animationName} raw sprite`);
    const rawBytes = readFileSync(rawPath);
    validateRawSpriteBytes(rawBytes, sprite);
    rawSpriteBytes.set(sprite.animationName, rawBytes);
  }
  const sourceBytes = new Map();
  for (const source of contract.sources) {
    const path = join(root, source.file);
    assertRegularFile(path, `${source.kind} source`);
    const bytes = readFileSync(path);
    validateSourceBytes(bytes, source);
    sourceBytes.set(source.kind, bytes);
  }
  for (const entry of contract.provenance) {
    const path = join(root, entry.file);
    assertRegularFile(path, entry.kind);
    const digest = sha256(readFileSync(path));
    if (digest !== entry.sha256) {
      throw new Error(`${entry.kind} SHA-256 mismatch: expected ${entry.sha256}, received ${digest}.`);
    }
  }

  return {
    root,
    manifest,
    contract,
    contractSha256: manifest.contractSha256,
    spriteBytes,
    rawSpriteBytes,
    sourceBytes,
  };
}

export function spriteMetadataMatches(actual, expected, { requireHash = true } = {}) {
  return actual?.animationName === expected.animationName
    && actual?.qualityTier === 'champion'
    && actual?.frameWidth === expected.frameWidth
    && actual?.frameHeight === expected.frameHeight
    && actual?.frameCount === expected.frameCount
    && actual?.animationFormat === TRUMP_VIDEO_ROSTER_CONTRACT.animationFormat
    && actual?.processingVersion === TRUMP_VIDEO_ROSTER_CONTRACT.processingVersion
    && (!requireHash || (
      actual?.contentHash === expected.sha256
      && actual?.rawContentHash === expected.rawSha256
    ));
}
