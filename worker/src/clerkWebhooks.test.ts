import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserWebhookEvent, WebhookEvent } from '@clerk/backend/webhooks';
import {
  handleClerkWebhook,
  processClerkUserWebhook,
  purgeR2Prefix,
} from './clerkWebhooks';
import { upsertClerkUser } from './auth';
import type { Env, User } from './types';

const SIGNING_SECRET = 'whsec_c3VwZXItc2VjcmV0';

class FakeR2Bucket {
  readonly keys = new Set<string>();

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const prefix = options.prefix ?? '';
    const limit = options.limit ?? 1000;
    const matches = Array.from(this.keys).filter((key) => key.startsWith(prefix)).sort();
    const selected = matches.slice(0, limit);
    return {
      objects: selected.map((key) => ({ key }) as R2Object),
      truncated: matches.length > selected.length,
      cursor: matches.length > selected.length ? 'more' : '',
      delimitedPrefixes: [],
    };
  }

  async delete(input: string | string[]): Promise<void> {
    for (const key of Array.isArray(input) ? input : [input]) this.keys.delete(key);
  }
}

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly database: FakeD1Database,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve(this.database.first(this.query, this.values) as T | null);
  }

  run(): Promise<D1Result> {
    this.database.run(this.query, this.values);
    return Promise.resolve({ success: true, meta: {} } as D1Result);
  }
}

class FakeD1Database {
  readonly users = new Map<string, User>();
  readonly tombstones = new Map<string, string>();
  readonly webhookEvents = new Map<string, string>();
  readonly executedQueries: string[] = [];

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]): Promise<D1Result[]> {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true, meta: {} }) as D1Result);
  }

  first(query: string, values: unknown[]): unknown {
    if (query.includes('FROM clerk_webhook_events')) {
      const id = String(values[0]);
      return this.webhookEvents.has(id) ? { id } : null;
    }
    if (query.includes('FROM clerk_user_tombstones')) {
      const subjectHash = String(values[0]);
      return this.tombstones.has(subjectHash) ? { subject_hash: subjectHash } : null;
    }
    if (query.includes('WHERE clerk_user_id = ?')) {
      const clerkUserId = String(values[0]);
      const user = Array.from(this.users.values()).find((candidate) => candidate.clerk_user_id === clerkUserId);
      return user ? { id: user.id, stripe_customer_id: user.stripe_customer_id } : null;
    }
    if (query.includes('SELECT * FROM users WHERE id = ?')) {
      return this.users.get(String(values[0])) ?? null;
    }
    return null;
  }

  run(query: string, values: unknown[]): void {
    this.executedQueries.push(query.replace(/\s+/g, ' ').trim());
    if (query.includes('INSERT INTO users')) {
      const id = String(values[0]);
      const clerkUserId = String(values[1]);
      const displayName = String(values[2]);
      const avatarUrl = values[3] == null ? null : String(values[3]);
      const email = values[4] == null ? null : String(values[4]);
      const subjectHash = String(values[6]);
      if (this.tombstones.has(subjectHash)) return;
      const existing = this.users.get(id);
      const preserveMissingFields = Number(values[7]) === 1;
      const hasDisplayName = Number(values[8]) === 1;
      this.users.set(id, fakeUser(
        id,
        clerkUserId,
        preserveMissingFields && !hasDisplayName ? existing?.display_name ?? displayName : displayName,
        preserveMissingFields && avatarUrl === null ? existing?.avatar_url ?? null : avatarUrl,
        preserveMissingFields && email === null ? existing?.email ?? null : email,
      ));
      return;
    }
    if (query.includes('INSERT INTO clerk_user_tombstones')) {
      this.tombstones.set(String(values[0]), String(values[1]));
      return;
    }
    if (query.includes('INSERT OR IGNORE INTO clerk_webhook_events')) {
      const eventType = values[1] ? String(values[1]) : 'user.deleted';
      if (!this.webhookEvents.has(String(values[0]))) {
        this.webhookEvents.set(String(values[0]), eventType);
      }
      return;
    }
    if (query.includes('DELETE FROM users WHERE clerk_user_id = ?')) {
      const clerkUserId = String(values[0]);
      for (const [id, user] of this.users) {
        if (user.clerk_user_id === clerkUserId) this.users.delete(id);
      }
    }
  }
}

function fakeUser(
  id: string,
  clerkUserId = id,
  displayName = 'Player',
  avatarUrl: string | null = null,
  email: string | null = null,
): User {
  return {
    id,
    clerk_user_id: clerkUserId,
    display_name: displayName,
    avatar_url: avatarUrl,
    email,
    plan_tier: 'free',
    credits_balance: 0,
    free_rookie_generations_used: 0,
    stripe_customer_id: null,
    elo_rating: 1200,
    wins: 0,
    losses: 0,
    win_streak: 0,
    best_streak: 0,
    total_kos: 0,
    created_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:00.000Z',
  };
}

function fakeEnv(database = new FakeD1Database(), bucket = new FakeR2Bucket()): Env {
  return {
    DB: database as unknown as D1Database,
    SPRITES: bucket as unknown as R2Bucket,
    ENVIRONMENT: 'production',
    CORS_ORIGIN: 'https://insertplayer.ai',
    CLERK_WEBHOOK_SIGNING_SECRET: SIGNING_SECRET,
  };
}

function userEvent(type: 'user.created' | 'user.updated', id = 'user_test'): UserWebhookEvent {
  return {
    type,
    object: 'event',
    data: {
      id,
      first_name: 'Ada',
      last_name: 'Player',
      username: 'ada',
      image_url: 'https://img.clerk.com/avatar.png',
      primary_email_address_id: 'email_primary',
      email_addresses: [{ id: 'email_primary', email_address: 'ada@example.com' }],
    },
    event_attributes: { http_request: { client_ip: '203.0.113.1', user_agent: 'test' } },
  } as UserWebhookEvent;
}

function signedRequest(event: WebhookEvent, eventId: string): Request {
  const payload = JSON.stringify(event);
  const timestamp = new Date();
  const signature = new Webhook(SIGNING_SECRET).sign(eventId, timestamp, payload);
  return new Request('https://api.insertplayer.ai/api/clerk/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': eventId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': signature,
    },
    body: payload,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Clerk user lifecycle webhook', () => {
  it('verifies, syncs, and de-duplicates a signed user event', async () => {
    const database = new FakeD1Database();
    const env = fakeEnv(database);
    const event = userEvent('user.updated');

    const first = await handleClerkWebhook(signedRequest(event, 'msg_profile'), env);
    expect(first.status).toBe(200);
    expect(database.users.get('user_test')?.display_name).toBe('Ada Player');
    expect(database.users.get('user_test')?.email).toBe('ada@example.com');

    const duplicate = await handleClerkWebhook(signedRequest(event, 'msg_profile'), env);
    expect(await duplicate.json()).toMatchObject({ received: true, duplicate: true });
    expect(database.webhookEvents.size).toBe(1);
  });

  it('preserves webhook profile fields when session JWT claims are sparse', async () => {
    const database = new FakeD1Database();
    const env = fakeEnv(database);
    await processClerkUserWebhook(userEvent('user.created'), 'msg_created', env);

    await upsertClerkUser(env, 'user_test', {});

    expect(database.users.get('user_test')).toMatchObject({
      display_name: 'Ada Player',
      avatar_url: 'https://img.clerk.com/avatar.png',
      email: 'ada@example.com',
    });
  });

  it('rejects invalid signatures without touching account data', async () => {
    const database = new FakeD1Database();
    const request = signedRequest(userEvent('user.created'), 'msg_bad_signature');
    request.headers.set('svix-signature', 'v1,invalid');

    const response = await handleClerkWebhook(request, fakeEnv(database));
    expect(response.status).toBe(400);
    expect(database.users.size).toBe(0);
  });

  it('acknowledges unrelated signed events without persisting them', async () => {
    const database = new FakeD1Database();
    const event = {
      type: 'session.created',
      object: 'event',
      data: { id: 'sess_test', object: 'session' },
    } as WebhookEvent;

    const response = await handleClerkWebhook(signedRequest(event, 'msg_session'), fakeEnv(database));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, ignored: true });
    expect(database.executedQueries).toEqual([]);
    expect(database.webhookEvents.size).toBe(0);
    expect(database.users.size).toBe(0);
  });

  it('deletes every R2 page, tombstones the subject, and removes the user', async () => {
    const database = new FakeD1Database();
    const bucket = new FakeR2Bucket();
    database.users.set('user_delete', fakeUser('user_delete'));
    for (let index = 0; index < 1205; index += 1) {
      bucket.keys.add(`users/user_delete/fighters/f${index}/sprite.png`);
    }
    bucket.keys.add('users/user_other/fighters/keep/sprite.png');

    const event = {
      type: 'user.deleted',
      object: 'event',
      data: { id: 'user_delete', object: 'user', deleted: true },
      event_attributes: { http_request: { client_ip: '203.0.113.1', user_agent: 'test' } },
    } as UserWebhookEvent;
    const result = await processClerkUserWebhook(event, 'msg_delete', fakeEnv(database, bucket));

    expect(result).toEqual({ outcome: 'deleted', assetsDeleted: 1205 });
    expect(Array.from(bucket.keys)).toEqual(['users/user_other/fighters/keep/sprite.png']);
    expect(database.users.has('user_delete')).toBe(false);
    expect(database.tombstones.size).toBe(1);
    expect(database.webhookEvents.get('msg_delete')).toBe('user.deleted');
    expect(database.executedQueries.some((query) => query.startsWith('DELETE FROM matches'))).toBe(true);
  });

  it('deletes the account-scoped Stripe Customer before removing local account rows', async () => {
    const database = new FakeD1Database();
    const user = fakeUser('user_stripe_delete');
    user.stripe_customer_id = 'cus_insertplayer';
    database.users.set(user.id, user);
    const stripeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith('/v1/account')) return Response.json({ id: 'acct_insertplayer' });
      if (url.endsWith('/v1/customers/cus_insertplayer')) {
        expect(init?.method).toBe('DELETE');
        return Response.json({ id: 'cus_insertplayer', deleted: true });
      }
      throw new Error(`Unexpected Stripe URL: ${url}`);
    });
    vi.stubGlobal('fetch', stripeFetch);
    const env = fakeEnv(database);
    env.STRIPE_SECRET_KEY = 'sk_live_insert_player';
    env.STRIPE_ACCOUNT_ID = 'acct_insertplayer';
    const event = {
      type: 'user.deleted',
      object: 'event',
      data: { id: user.clerk_user_id, object: 'user', deleted: true },
      event_attributes: { http_request: { client_ip: '203.0.113.1', user_agent: 'test' } },
    } as UserWebhookEvent;

    const result = await processClerkUserWebhook(event, 'msg_stripe_delete', env);

    expect(result).toMatchObject({ outcome: 'deleted', stripeCustomerDeleted: true });
    expect(stripeFetch).toHaveBeenCalledTimes(2);
    expect(database.users.has(user.id)).toBe(false);
  });

  it('bounds a single R2 purge attempt so webhook retries can continue large deletions', async () => {
    const bucket = new FakeR2Bucket();
    for (let index = 0; index < 1001; index += 1) bucket.keys.add(`users/user_large/${index}`);

    await expect(purgeR2Prefix(bucket as unknown as R2Bucket, 'users/user_large/', 1))
      .rejects.toThrow('another delivery');
    expect(bucket.keys.size).toBe(1);
  });
});
