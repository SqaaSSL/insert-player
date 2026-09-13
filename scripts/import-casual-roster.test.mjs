import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CASUAL_ANIMATIONS, CASUAL_FRAME_COUNTS, CASUAL_IDENTITY, createCasualApiClient, executeCasualImport,
  runCasualImportCli, validateCasualManifest } from './import-casual-roster.mjs';

const SHA = '1'.repeat(40), OWNER = 'user_admin', ID = 'a'.repeat(32);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

// Valid opaque indexed PNGs keep the production-sized fixture sheets small on disk.
const pngCache = new Map();
function flatPng(width, height) {
  const key = `${width}x${height}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const chunk = (type, bytes) => {
    const payload = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 1; header[9] = 3;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('PLTE', Buffer.from([128, 128, 128])),
    chunk('IDAT', deflateSync(Buffer.alloc((Math.ceil(width / 8) + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
  pngCache.set(key, png); return png;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'casual-import-test-')); paths.push(root);
  const original = readFileSync(new URL('../public/assets/landing-panel-photo2-2de4f7af.webp', import.meta.url));
  const png = flatPng(1, 1);
  const manifest = { schemaVersion: 1, identity: { ...CASUAL_IDENTITY }, sources: [], sprites: [] };
  const add = (path, bytes) => { writeFileSync(join(root, path), bytes); return { path, sha256: digest(bytes), bytes: bytes.length }; };
  for (const kind of ['original', 'side', 'side_raw', 'upright', 'upright_raw', 'crouch', 'crouch_raw']) {
    manifest.sources.push({ kind, ...add(`${kind}.${kind === 'original' ? 'webp' : 'png'}`, kind === 'original' ? original : png),
      mime: kind === 'original' ? 'image/webp' : 'image/png' });
  }
  for (const qualityTier of ['rookie', 'contender']) for (const animationName of CASUAL_ANIMATIONS) {
    const frameCount = CASUAL_FRAME_COUNTS[animationName], gridCols = 4, gridRows = Math.ceil(frameCount / gridCols);
    const processed = add(`${qualityTier}-${animationName}.png`, flatPng(768 * gridCols, 1024 * gridRows));
    const raw = add(`${qualityTier}-${animationName}-raw.png`, png);
    manifest.sprites.push({ ...processed, animationName, qualityTier, animationFormat: 'legacy',
      mime: 'image/png', frameWidth: 768, frameHeight: 1024, frameCount, gridCols, gridRows, processingVersion: 5,
      rawPath: raw.path, rawSha256: raw.sha256, rawBytes: raw.bytes, rawWidth: 1, rawHeight: 1, rawMime: 'image/png' });
  }
  const path = join(root, 'manifest.json');
  const seal = () => { const bytes = Buffer.from(JSON.stringify(manifest)); writeFileSync(path, bytes); return digest(bytes); };
  return { root, manifest, path, seal, bundle: () => validateCasualManifest(path, seal()) };
}

class FakeClient {
  constructor(bundle) {
    this.bundle = bundle; this.log = []; this.created = false; this.status = null;
    this.sources = {}; this.sourceHashes = {}; this.versions = []; this.current = [];
    this.failAfterUploads = null; this.failPublic = false; this.uploads = 0;
  }
  health = async () => ({ status: 'ok', environment: 'production', storage: { d1: 'bound', r2: 'bound' }, workerVersion: { tag: `prod-${SHA}-1` } });
  listAdminArcade = async () => this.status ? [{ fighterId: ID, slug: 'casual', rank: 16, status: this.status }] : [];
  listOwned = async () => this.created && !this.status ? [await this.getFighter()] : [];
  createFighter = async () => { this.log.push('create'); this.created = true; return this.getFighter(); };
  getFighter = async () => ({ id: ID, ownerUserId: OWNER, name: 'Casual', photoHash: CASUAL_IDENTITY.sourceSha256,
    qualityTier: 'contender', public: this.status === 'active', sources: { ...this.sources }, sourceHashes: { ...this.sourceHashes },
    sprites: structuredClone(this.current), spriteVersions: structuredClone(this.versions) });
  setArcade = async (_id, metadata) => { this.log.push(`status:${metadata.status}`); this.status = metadata.status; return { fighter: { status: this.status } }; };
  uploadSource = async (_id, source, bytes) => {
    this.log.push(`source:${source.kind}`); expect(digest(bytes)).toBe(source.sha256);
    const responseKey = { side_raw: 'sideRaw', upright_raw: 'uprightRaw', crouch_raw: 'crouchRaw' }[source.kind] ?? source.kind;
    this.sources[responseKey] = `https://api.insertplayer.ai/assets/${source.path}`;
    this.sourceHashes[source.kind] = source.sha256;
  };
  row(sprite) { return { ...sprite, id: `${sprite.qualityTier}-${sprite.animationName}`, contentHash: sprite.sha256,
    rawContentHash: sprite.rawSha256, url: `https://api.insertplayer.ai/assets/${sprite.path}`,
    rawUrl: `https://api.insertplayer.ai/assets/${sprite.rawPath}` }; }
  uploadSprite = async (_id, sprite, bytes, rawBytes) => {
    if (this.failAfterUploads === this.uploads) throw new Error('Simulated interrupted upload');
    this.uploads++; this.log.push(`sprite:${sprite.qualityTier}:${sprite.animationName}`);
    expect(digest(bytes)).toBe(sprite.sha256); expect(digest(rawBytes)).toBe(sprite.rawSha256);
    this.versions.push(this.row(sprite));
  };
  promoteSprite = async (_id, sprite) => {
    this.log.push(`promote:${sprite.qualityTier}:${sprite.animationName}`);
    this.current = this.current.filter(row => row.animationName !== sprite.animationName || row.qualityTier !== sprite.qualityTier);
    this.current.push(this.row(sprite));
  };
  download = async url => {
    const path = new URL(url).pathname.replace(/^\/(public-assets|assets)\//, '');
    const bytes = this.bundle.files.get(path); if (!bytes) throw new Error(`Unknown fixture download: ${path}`);
    return bytes;
  };
  publicRoster = async () => {
    if (this.failPublic) throw new Error('Simulated public verification failure');
    if (this.status !== 'active') return [];
    const fighter = await this.getFighter();
    return [{ ...fighter, arcade: { slug: 'casual', reference: { kind: 'generated' } },
      sources: { ...this.sources, original: null, sideRaw: null, uprightRaw: null, crouchRaw: null },
      assetPacks: ['fight-v1', 'aura-v1-2026'].map(id => ({ id, status: 'ready', qualityTier: 'contender' })),
      sprites: this.current.map(row => ({ ...row, rawUrl: null, rawContentHash: null })) }];
  };
  purgeArcadeCache = async () => { this.log.push('purge'); };
}
const execute = (bundle, client) => executeCasualImport({ bundle, client, ownerId: OWNER, expectedSha: SHA });

describe('sealed Casual roster import', () => {
  it('validates both complete real-tier packs and all original/raw bytes offline', () => {
    const input = fixture(), bundle = input.bundle();
    expect(bundle.manifest.sprites).toHaveLength(34);
    expect(bundle.manifest.sources[0]).toMatchObject({ mime: 'image/webp', sha256: CASUAL_IDENTITY.sourceSha256 });
    expect(bundle.files.size).toBe(75);
  });

  it.each([
    ['incomplete pack', manifest => manifest.sprites.pop()],
    ['mixed retired tier', manifest => { manifest.sprites[17].qualityTier = 'champion'; }],
    ['duplicate animation', manifest => { manifest.sprites[1].animationName = 'idle'; }],
    ['wrong original', manifest => { manifest.identity.sourceSha256 = '2'.repeat(64); }],
    ['unsafe path', manifest => { manifest.sprites[0].path = '../outside.png'; }],
    ['fabricated HQ', manifest => { manifest.sprites[0].animationFormat = 'video-dense-v1'; }],
    ['false raw geometry', manifest => { manifest.sprites[0].rawWidth = 2; }],
    ['truncated playback', manifest => { manifest.sprites[0].frameCount = 1; }],
    ['false frame resolution', manifest => { manifest.sprites[0].frameWidth = 192; }],
    ['false processed MIME', manifest => { manifest.sprites[0].mime = 'image/webp'; }],
    ['false raw size', manifest => { manifest.sprites[0].rawBytes += 1; }],
  ])('rejects %s before creating credentials or touching the network', async (_label, corrupt) => {
    const input = fixture(); corrupt(input.manifest);
    const createTokenProvider = vi.fn(), createClient = vi.fn();
    await expect(runCasualImportCli([`--manifest=${input.path}`, `--manifest-sha256=${input.seal()}`, '--execute'],
      { createTokenProvider, createClient })).rejects.toThrow();
    expect(createTokenProvider).not.toHaveBeenCalled(); expect(createClient).not.toHaveBeenCalled();
  });

  it('rejects a changed manifest hash and changed asset bytes before network access', async () => {
    const input = fixture(), sha = input.seal(), createTokenProvider = vi.fn();
    await expect(runCasualImportCli([`--manifest=${input.path}`, `--manifest-sha256=${'f'.repeat(64)}`], { createTokenProvider }))
      .rejects.toThrow('Manifest SHA-256 mismatch');
    writeFileSync(join(input.root, input.manifest.sprites[0].path), 'corrupt');
    await expect(runCasualImportCli([`--manifest=${input.path}`, `--manifest-sha256=${sha}`], { createTokenProvider }))
      .rejects.toThrow('Asset hash or size mismatch');
    expect(createTokenProvider).not.toHaveBeenCalled();
  });

  it('archives both tiers, promotes only verified Champion, and retries without changing characters or versions', async () => {
    const bundle = fixture().bundle(), client = new FakeClient(bundle);
    const receipt = await execute(bundle, client);
    expect(receipt.status).toBe('active'); expect(client.versions).toHaveLength(34);
    expect(client.current).toHaveLength(17); expect(client.current.every(row => row.qualityTier === 'contender')).toBe(true);
    expect(client.log.indexOf('status:draft')).toBeLessThan(client.log.indexOf('source:original'));
    expect(client.log.filter(entry => entry.startsWith('promote:'))).toHaveLength(17);
    const before = [...client.log];
    expect((await execute(bundle, client)).status).toBe('already-active');
    expect(client.log).toEqual([...before, 'purge']); expect(client.versions).toHaveLength(34);
  });

  it('leaves a failed import in draft with every staged version preserved, then resumes without duplicates', async () => {
    const bundle = fixture().bundle(), client = new FakeClient(bundle);
    client.failAfterUploads = 5;
    await expect(execute(bundle, client)).rejects.toThrow('interrupted upload');
    expect(client.status).toBe('draft'); expect(client.versions).toHaveLength(5);
    expect(client.log).not.toContain('status:active'); expect(client.current).toHaveLength(0);
    client.failAfterUploads = null;
    expect((await execute(bundle, client)).status).toBe('active');
    expect(client.versions).toHaveLength(34);
    expect(client.log.filter(entry => entry === 'source:original')).toHaveLength(1);
  });

  it('returns to draft if public verification fails after activation', async () => {
    const bundle = fixture().bundle(), client = new FakeClient(bundle); client.failPublic = true;
    await expect(execute(bundle, client)).rejects.toThrow('public verification');
    expect(client.status).toBe('draft'); expect(client.versions).toHaveLength(34);
    expect(client.current).toHaveLength(17);
  });

  it('never overwrites an existing original or a conflicting official slug', async () => {
    const bundle = fixture().bundle(), client = new FakeClient(bundle);
    client.created = true; client.sources.original = 'https://api.insertplayer.ai/assets/other.webp';
    client.sourceHashes.original = 'f'.repeat(64);
    await expect(execute(bundle, client)).rejects.toThrow('refusing to replace'); expect(client.log).toEqual([]);
    client.sources = {}; client.sourceHashes = {};
    client.listAdminArcade = async () => [{ fighterId: ID, slug: 'somebody-else', status: 'draft' }];
    await expect(execute(bundle, client)).rejects.toThrow('another official slug'); expect(client.log).toEqual([]);
  });

  it('rejects duplicate Casual slugs before mutation and a mismatched live Worker before even reading rosters', async () => {
    const bundle = fixture().bundle(), client = new FakeClient(bundle);
    client.listAdminArcade = vi.fn(async () => [{ slug: 'casual' }, { slug: 'casual' }]);
    await expect(execute(bundle, client)).rejects.toThrow('Duplicate Casual Arcade slug'); expect(client.log).toEqual([]);
    client.health = async () => ({ status: 'ok', workerVersion: { tag: `prod-${'2'.repeat(40)}-1` } });
    client.listAdminArcade.mockClear();
    await expect(execute(bundle, client)).rejects.toThrow('exact production commit');
    expect(client.listAdminArcade).not.toHaveBeenCalled();
  });

  it('skips an unrelated unavailable admin identity but fails if Casual itself is unavailable', async () => {
    const bundle = fixture().bundle(), client = new FakeClient(bundle), getFighter = client.getFighter;
    client.listAdminArcade = async () => [{ fighterId: 'b'.repeat(32), slug: 'unrelated', status: 'draft' }];
    client.getFighter = async id => {
      if (id === 'b'.repeat(32)) throw Object.assign(new Error('Unavailable unrelated fighter'), { status: 404 });
      return getFighter(id);
    };
    expect((await execute(bundle, client)).status).toBe('active');
    const untouched = new FakeClient(bundle);
    untouched.listAdminArcade = async () => [{ fighterId: 'b'.repeat(32), slug: 'casual', status: 'draft' }];
    untouched.getFighter = async () => { throw Object.assign(new Error('Unavailable Casual fighter'), { status: 404 }); };
    await expect(execute(bundle, untouched)).rejects.toThrow('Unavailable Casual'); expect(untouched.log).toEqual([]);
  });

  it('purges the exact roster cache before verifying the canonical public URL', async () => {
    const bundle = fixture().bundle(), client = new FakeClient(bundle), publicRoster = client.publicRoster;
    let stale = true;
    client.publicRoster = async () => stale ? [] : publicRoster();
    client.purgeArcadeCache = async () => { client.log.push('purge'); stale = false; };
    expect((await execute(bundle, client)).status).toBe('active');
    expect(client.log.indexOf('purge')).toBeGreaterThan(client.log.indexOf('status:active'));
  });

  it('blocks local execution and wrong checked-out commit before credentials', async () => {
    const input = fixture(), createTokenProvider = vi.fn(), guard = vi.fn(() => ({ gitSha: '2'.repeat(40) }));
    const args = [`--manifest=${input.path}`, `--manifest-sha256=${input.seal()}`, '--execute',
      '--confirm=IMPORT_CASUAL_ROSTER_PRODUCTION_V1', `--expected-deployed-sha=${SHA}`, `--receipt=${join(input.root, 'receipt.json')}`];
    await expect(runCasualImportCli(args, { env: {}, guard, createTokenProvider })).rejects.toThrow('only in the main');
    expect(guard).not.toHaveBeenCalled();
    await expect(runCasualImportCli(args, { env: { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: SHA }, guard, createTokenProvider })).rejects.toThrow('clean main checkout');
    expect(createTokenProvider).not.toHaveBeenCalled();
  });

  it('writes a resumable non-secret receipt through the exact guarded workflow CLI', async () => {
    const input = fixture(), bundle = input.bundle(), client = new FakeClient(bundle);
    const receiptPath = join(input.root, 'receipt.json');
    const createClient = vi.fn(() => client), guard = vi.fn(() => ({ gitSha: SHA }));
    const tokenProvider = { userId: OWNER, getToken: vi.fn(async () => 'private-token') };
    const result = await runCasualImportCli([`--manifest=${input.path}`, `--manifest-sha256=${bundle.manifestSha256}`,
      '--execute', '--confirm=IMPORT_CASUAL_ROSTER_PRODUCTION_V1', `--expected-deployed-sha=${SHA}`, `--receipt=${receiptPath}`], {
      env: { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_SHA: SHA, CLERK_BACKEND_AUTH_BRIDGE_SECRET: 'bridge-private', CLOUDFLARE_API_TOKEN: 'cf-private',
        ASF_CLOUDFLARE_ZONE_ID: 'd'.repeat(32) },
      guard, createTokenProvider: async () => tokenProvider, createClient, stdout: vi.fn(),
    });
    expect(result.status).toBe('active'); expect(guard).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ cloudflareApiToken: 'cf-private',
      cloudflareZoneId: 'd'.repeat(32), baseUrl: 'https://api.insertplayer.ai' }));
    const receipt = readFileSync(receiptPath, 'utf8');
    expect(JSON.parse(receipt)).toMatchObject({ status: 'active', fighterId: ID, gitSha: SHA });
    expect(receipt).not.toMatch(/private-token|bridge-private|cf-private/);
  });

  it('sends the original as WebP and both sprite versions as staged legacy assets without credential leakage', async () => {
    const bundle = fixture().bundle(), fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const tokenProvider = { userId: OWNER, getToken: vi.fn(async () => 'private-token') };
    const client = createCasualApiClient({ tokenProvider, backendAuthBridgeSecret: 'x'.repeat(32),
      cloudflareApiToken: 'c'.repeat(32), cloudflareZoneId: 'd'.repeat(32), fetchImpl });
    const source = bundle.manifest.sources[0], sprite = bundle.manifest.sprites[0];
    await client.uploadSource(ID, source, bundle.files.get(source.path));
    expect(fetchImpl.mock.calls[0][1].body.get('file').type).toBe('image/webp');
    await client.uploadSprite(ID, sprite, bundle.files.get(sprite.path), bundle.files.get(sprite.rawPath));
    expect(fetchImpl.mock.calls[1][1].body.get('setCurrent')).toBe('false');
    expect(fetchImpl.mock.calls[1][1].body.get('animationFormat')).toBe('legacy');
    await client.publicRoster();
    expect(fetchImpl.mock.calls[2][1].headers).not.toHaveProperty('Authorization');
    await expect(client.download('https://elsewhere.example/assets/raw.png')).rejects.toThrow('foreign');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never broad-purges or forwards Clerk credentials to Cloudflare', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"success":true}'));
    const client = createCasualApiClient({ tokenProvider: { getToken: vi.fn(async () => 'clerk-private') },
      backendAuthBridgeSecret: 'x'.repeat(32), cloudflareApiToken: 'c'.repeat(32), cloudflareZoneId: 'd'.repeat(32), fetchImpl });
    await client.purgeArcadeCache();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${'d'.repeat(32)}/purge_cache`);
    expect(JSON.parse(options.body)).toEqual({ files: ['https://api.insertplayer.ai/api/arcade'] });
    expect(options.headers.Authorization).toBe(`Bearer ${'c'.repeat(32)}`);
    expect(options.headers).not.toHaveProperty('X-Insert-Player-Clerk-Backend-Auth');
  });
});
