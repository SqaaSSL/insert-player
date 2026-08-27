import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createProductionApiClient,
  executeTrumpVideoRosterImport,
  runTrumpVideoRosterCli,
} from './import-trump-video-roster.mjs';

const EXPECTED_SHA = '1'.repeat(40);
const OWNER_ID = 'user_arcade_admin';

function png(marker) {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  bytes[24] = marker;
  return bytes;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixtureBundle() {
  const processed = png(1);
  const raw = png(2);
  const sourceBytes = png(3);
  const sprite = {
    animationName: 'idle',
    file: 'sprites/idle.png',
    rawFile: 'sprites/raw/idle.png',
    sha256: digest(processed),
    rawSha256: digest(raw),
    sizeBytes: processed.length,
    rawSizeBytes: raw.length,
    sheetWidth: 1,
    sheetHeight: 1,
    rawSheetWidth: 1,
    rawSheetHeight: 1,
    frameWidth: 1,
    frameHeight: 1,
    frameCount: 1,
  };
  const source = {
    kind: 'original',
    responseKey: 'original',
    hashKey: 'original',
    file: 'sources/original.png',
    sha256: digest(sourceBytes),
    sizeBytes: sourceBytes.length,
    width: 1,
    height: 1,
  };
  return {
    contractSha256: '2'.repeat(64),
    contract: {
      schemaVersion: 1,
      bundleId: 'test-bundle',
      fighter: {
        id: 'a'.repeat(32),
        slug: 'donald-trump',
        name: 'Donald Trump',
        photoHash: source.sha256,
        qualityTier: 'champion',
      },
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
      sprites: [sprite],
      sources: [source],
      provenance: [],
    },
    spriteBytes: new Map([['idle', processed]]),
    rawSpriteBytes: new Map([['idle', raw]]),
    sourceBytes: new Map([['original', sourceBytes]]),
  };
}

function privateSprite(sprite) {
  return {
    animationName: sprite.animationName,
    qualityTier: 'champion',
    frameWidth: sprite.frameWidth,
    frameHeight: sprite.frameHeight,
    frameCount: sprite.frameCount,
    animationFormat: 'video-dense-v1',
    processingVersion: 5,
    contentHash: sprite.sha256,
    rawContentHash: sprite.rawSha256,
    url: `https://api.insertplayer.ai/assets/sprites/${sprite.animationName}.png`,
    rawUrl: `https://api.insertplayer.ai/assets/sprites/raw/${sprite.animationName}.png`,
  };
}

class FakeProductionClient {
  constructor(bundle, {
    active = false,
    failPublic = false,
    omitPublicContentHash = false,
    leakPublicRawMetadata = false,
  } = {}) {
    this.bundle = bundle;
    this.expectedOwnerUserId = OWNER_ID;
    this.status = active ? 'active' : 'draft';
    this.public = active;
    this.failPublic = failPublic;
    this.omitPublicContentHash = omitPublicContentHash;
    this.leakPublicRawMetadata = leakPublicRawMetadata;
    this.log = [];
    this.currentSprites = active ? bundle.contract.sprites.map(privateSprite) : [];
    this.spriteVersions = active ? bundle.contract.sprites.map(privateSprite) : [];
    this.sources = {};
    this.sourceHashes = {};
    if (active) {
      for (const source of bundle.contract.sources) {
        this.sources[source.responseKey] = `https://api.insertplayer.ai/assets/sources/${source.kind}.png`;
        this.sourceHashes[source.hashKey] = source.sha256;
      }
    }
  }

  health = async () => {
    this.log.push('health');
    return {
      status: 'ok',
      environment: 'production',
      storage: { d1: 'bound', r2: 'bound' },
      workerVersion: { id: 'worker-version-id', tag: `prod-${EXPECTED_SHA}-1` },
    };
  };

  getFighter = async () => {
    this.log.push('get-fighter');
    return {
      id: this.bundle.contract.fighter.id,
      ownerUserId: OWNER_ID,
      name: this.bundle.contract.fighter.name,
      photoHash: this.bundle.contract.fighter.photoHash,
      qualityTier: 'champion',
      public: this.public,
      sources: { ...this.sources },
      sourceHashes: { ...this.sourceHashes },
      sprites: structuredClone(this.currentSprites),
      spriteVersions: structuredClone(this.spriteVersions),
    };
  };

  listAdminArcade = async () => {
    this.log.push('list-admin');
    return [{
      fighterId: this.bundle.contract.fighter.id,
      fighterName: this.bundle.contract.fighter.name,
      qualityTier: 'champion',
      public: this.public,
      slug: this.bundle.contract.fighter.slug,
      status: this.status,
    }];
  };

  uploadSource = async (_fighterId, source) => {
    this.log.push(`source:${source.kind}`);
    this.sources[source.responseKey] = `https://api.insertplayer.ai/assets/sources/${source.kind}.png`;
    this.sourceHashes[source.hashKey] = source.sha256;
    return {};
  };

  uploadSprite = async (_fighterId, sprite) => {
    this.log.push(`stage:${sprite.animationName}`);
    this.spriteVersions = [privateSprite(sprite)];
    return {};
  };

  promoteSprite = async (_fighterId, sprite) => {
    this.log.push(`promote:${sprite.animationName}`);
    this.currentSprites = [privateSprite(sprite)];
    return {};
  };

  setArcadeStatus = async (_fighterId, status) => {
    this.log.push(`status:${status}`);
    this.status = status;
    this.public = status === 'active';
    return { fighter: { status } };
  };

  purgeArcadeCache = async () => {
    this.log.push('purge');
    return {};
  };

  getPublicArcade = async () => {
    this.log.push('public');
    if (this.failPublic) throw new Error('public smoke failed');
    if (!this.public) return [];
    return [{
      id: this.bundle.contract.fighter.id,
      name: this.bundle.contract.fighter.name,
      public: true,
      arcade: { slug: this.bundle.contract.fighter.slug },
      sources: {
        original: null,
        side: null,
        sideRaw: null,
        upright: null,
        uprightRaw: null,
        crouch: null,
        crouchRaw: null,
      },
      sprites: this.currentSprites.map((sprite) => ({
        ...sprite,
        contentHash: this.omitPublicContentHash ? undefined : sprite.contentHash,
        rawContentHash: this.leakPublicRawMetadata ? sprite.rawContentHash : undefined,
        rawUrl: this.leakPublicRawMetadata ? sprite.rawUrl : null,
        url: `https://api.insertplayer.ai/public-assets/sprites/${sprite.animationName}.png`,
      })),
    }];
  };

  downloadPrivateSource = async () => {
    this.log.push('download-source');
    return this.bundle.sourceBytes.get('original');
  };

  downloadPrivateSprite = async (url) => {
    this.log.push(url.includes('/raw/') ? 'download-raw' : 'download-processed');
    return url.includes('/raw/')
      ? this.bundle.rawSpriteBytes.get('idle')
      : this.bundle.spriteBytes.get('idle');
  };

  downloadPublicSprite = async () => {
    this.log.push('download-public');
    return this.bundle.spriteBytes.get('idle');
  };

  downloadPublicSource = async () => this.bundle.sourceBytes.get('original');
}

describe('Trump production importer', () => {
  it('plans with no credentials and constructs no auth or network client', async () => {
    const bundle = fixtureBundle();
    let authConstructions = 0;
    let clientConstructions = 0;
    let output = '';
    const plan = await runTrumpVideoRosterCli(['--bundle=/fixture'], {
      env: {},
      stdout: (text) => { output += text; },
      validateBundle: () => bundle,
      createTokenProvider: async () => {
        authConstructions += 1;
        throw new Error('plan touched auth');
      },
      createApiClient: () => {
        clientConstructions += 1;
        throw new Error('plan constructed API client');
      },
    });
    expect(plan.mode).toBe('plan');
    expect(JSON.parse(output).mode).toBe('plan');
    expect(authConstructions).toBe(0);
    expect(clientConstructions).toBe(0);
  });

  it('repairs sources, stages raw and processed sprites, promotes while draft, then activates and purges', async () => {
    const bundle = fixtureBundle();
    const client = new FakeProductionClient(bundle);
    let tick = 0;
    const receipt = await executeTrumpVideoRosterImport({
      bundle,
      client,
      expectedDeployedSha: EXPECTED_SHA,
      now: () => `2026-08-26T00:00:${String(tick++).padStart(2, '0')}Z`,
    });

    expect(receipt.status).toBe('activated');
    expect(client.status).toBe('active');
    expect(client.log.indexOf('source:original')).toBeLessThan(client.log.indexOf('stage:idle'));
    expect(client.log.indexOf('stage:idle')).toBeLessThan(client.log.indexOf('promote:idle'));
    expect(client.log.indexOf('promote:idle')).toBeLessThan(client.log.indexOf('status:active'));
    expect(client.log.indexOf('status:active')).toBeLessThan(client.log.indexOf('purge'));
    expect(client.log).toContain('download-raw');
    expect(client.log.at(-1)).toBe('download-public');
  });

  it('rolls an attempted activation back to draft and purges the rollback on public-smoke failure', async () => {
    const bundle = fixtureBundle();
    const client = new FakeProductionClient(bundle, { failPublic: true });
    let error;
    try {
      await executeTrumpVideoRosterImport({ bundle, client, expectedDeployedSha: EXPECTED_SHA });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toMatch(/public smoke failed/);
    expect(error?.importReceipt?.rollback).toMatchObject({
      attempted: true,
      succeeded: true,
      cachePurgeSucceeded: true,
    });
    expect(client.status).toBe('draft');
    expect(client.log.filter((entry) => entry === 'purge')).toHaveLength(2);
    expect(client.log.slice(-2)).toEqual(['status:draft', 'purge']);
  });

  it('is a read-only resume when the exact roster is already active', async () => {
    const bundle = fixtureBundle();
    const client = new FakeProductionClient(bundle, { active: true });
    const receipt = await executeTrumpVideoRosterImport({ bundle, client, expectedDeployedSha: EXPECTED_SHA });
    expect(receipt.status).toBe('already-active');
    expect(client.log.some((entry) => entry.startsWith('source:'))).toBe(false);
    expect(client.log.some((entry) => entry.startsWith('stage:'))).toBe(false);
    expect(client.log.some((entry) => entry.startsWith('promote:'))).toBe(false);
    expect(client.log).toContain('purge');
  });

  it('fails closed to draft when verification of a pre-existing active resume fails', async () => {
    const bundle = fixtureBundle();
    const client = new FakeProductionClient(bundle, { active: true, failPublic: true });
    await expect(
      executeTrumpVideoRosterImport({ bundle, client, expectedDeployedSha: EXPECTED_SHA }),
    ).rejects.toThrow(/public smoke failed/);
    expect(client.status).toBe('draft');
    expect(client.log.some((entry) => entry.startsWith('source:'))).toBe(false);
    expect(client.log.some((entry) => entry.startsWith('stage:'))).toBe(false);
    expect(client.log.filter((entry) => entry === 'purge')).toHaveLength(2);
    expect(client.log.slice(-2)).toEqual(['status:draft', 'purge']);
  });

  it('requires the processed hash publicly while allowing the raw hash to remain private', async () => {
    const bundle = fixtureBundle();
    const client = new FakeProductionClient(bundle, { active: true, omitPublicContentHash: true });
    await expect(
      executeTrumpVideoRosterImport({ bundle, client, expectedDeployedSha: EXPECTED_SHA }),
    ).rejects.toThrow(/sealed idle sprite/);
    expect(client.status).toBe('draft');
  });

  it('rejects any public raw sprite URL or digest leak', async () => {
    const bundle = fixtureBundle();
    const client = new FakeProductionClient(bundle, { active: true, leakPublicRawMetadata: true });
    await expect(
      executeTrumpVideoRosterImport({ bundle, client, expectedDeployedSha: EXPECTED_SHA }),
    ).rejects.toThrow(/public raw URL must be exactly null/);
    expect(client.status).toBe('draft');
  });

  it('sends setCurrent=false, rawFile, and exact promotion identity to the API', async () => {
    const bundle = fixtureBundle();
    const calls = [];
    const client = createProductionApiClient({
      baseUrl: 'https://api.insertplayer.ai',
      tokenProvider: { userId: OWNER_ID, getToken: async () => 'header.payload.signature' },
      backendAuthBridgeSecret: 'b'.repeat(32),
      cloudflareApiToken: 'c'.repeat(40),
      cloudflareZoneId: 'd'.repeat(32),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        const body = url.startsWith('https://api.cloudflare.com/') ? '{"success":true}' : '{}';
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    const sprite = bundle.contract.sprites[0];
    await client.uploadSprite(
      bundle.contract.fighter.id,
      sprite,
      bundle.contract,
      bundle.spriteBytes.get('idle'),
      bundle.rawSpriteBytes.get('idle'),
    );
    await client.promoteSprite(bundle.contract.fighter.id, sprite, bundle.contract);
    await client.purgeArcadeCache();

    expect(calls[0].init.body.get('setCurrent')).toBe('false');
    expect(calls[0].init.body.get('animationFormat')).toBe('video-dense-v1');
    expect(calls[0].init.body.get('rawFile')).toBeInstanceOf(Blob);
    expect(JSON.parse(calls[1].init.body)).toMatchObject({
      animationName: 'idle',
      contentHash: sprite.sha256,
      rawContentHash: sprite.rawSha256,
      animationFormat: 'video-dense-v1',
      frameCount: 1,
    });
    expect(calls[2].url).toBe(`https://api.cloudflare.com/client/v4/zones/${'d'.repeat(32)}/purge_cache`);
    expect(JSON.parse(calls[2].init.body)).toEqual({ files: ['https://api.insertplayer.ai/api/arcade'] });
  });

  it('pins the manual workflow to a private EU R2 prefix and exact object hash', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/activate-trump-video-roster-production.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('insert-player-assets/$BUNDLE_R2_KEY');
    expect(workflow).toContain('^temp/arcade-imports/trump-video-roster-v1/');
    expect(workflow).toContain('--remote');
    expect(workflow).toContain('--jurisdiction eu');
    expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow).not.toMatch(/gh release|release asset/i);
  });
});
