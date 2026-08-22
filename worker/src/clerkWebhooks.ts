import { verifyWebhook, type UserWebhookEvent, type WebhookEvent } from '@clerk/backend/webhooks';
import {
  hashString,
  isClerkUserTombstoned,
  upsertClerkUserProfile,
} from './auth';
import type { Env } from './types';
import { readRequestText, RequestBodyTooLargeError } from './requestBody';

const R2_DELETE_BATCH_SIZE = 1000;
const MAX_R2_DELETE_BATCHES_PER_DELIVERY = 5;
const MAX_CLERK_ID_LENGTH = 128;
const MAX_WEBHOOK_ID_LENGTH = 255;
const MAX_CLERK_WEBHOOK_BODY_BYTES = 1024 * 1024;
const STRIPE_API_VERSION = '2026-02-25.clover';
const STRIPE_FETCH_TIMEOUT_MS = 15_000;

class IncompleteAssetPurgeError extends Error {}
class InvalidClerkWebhookPayloadError extends Error {}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function validClerkUserId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_CLERK_ID_LENGTH
    && /^user_[a-z0-9_-]+$/i.test(value);
}

function requiredWebhookId(request: Request): string {
  const eventId = request.headers.get('svix-id')?.trim() ?? '';
  if (!eventId || eventId.length > MAX_WEBHOOK_ID_LENGTH) {
    throw new InvalidClerkWebhookPayloadError('Invalid Clerk webhook id');
  }
  return eventId;
}

function isUserWebhookEvent(event: WebhookEvent): event is UserWebhookEvent {
  return event.type === 'user.created'
    || event.type === 'user.updated'
    || event.type === 'user.deleted';
}

async function webhookWasProcessed(env: Env, eventId: string): Promise<boolean> {
  const processed = await env.DB.prepare(
    'SELECT id FROM clerk_webhook_events WHERE id = ?'
  ).bind(eventId).first<{ id: string }>();
  return Boolean(processed);
}

async function recordWebhookEvent(env: Env, eventId: string, eventType: string): Promise<void> {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO clerk_webhook_events (id, event_type)
    VALUES (?, ?)
  `).bind(eventId, eventType).run();
}

function primaryEmail(data: Extract<UserWebhookEvent, { type: 'user.created' | 'user.updated' }>['data']): string | null {
  const primary = data.email_addresses.find((email) => email.id === data.primary_email_address_id);
  return primary?.email_address ?? data.email_addresses[0]?.email_address ?? null;
}

function webhookDisplayName(data: Extract<UserWebhookEvent, { type: 'user.created' | 'user.updated' }>['data']): string {
  const fullName = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
  return fullName || data.username || primaryEmail(data) || 'Player';
}

function webhookGrantsAdmin(data: Extract<UserWebhookEvent, { type: 'user.created' | 'user.updated' }>['data']): boolean {
  return data.private_metadata?.insert_player_role === 'admin';
}

async function syncClerkAdminRole(
  env: Env,
  clerkUserId: string,
  grantsAdmin: boolean,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE users
    SET
      plan_tier = CASE
        WHEN ? = 1 THEN 'admin'
        WHEN plan_tier = 'admin' THEN 'free'
        ELSE plan_tier
      END,
      updated_at = datetime('now')
    WHERE clerk_user_id = ?
  `).bind(grantsAdmin ? 1 : 0, clerkUserId).run();
}

export async function purgeR2Prefix(
  bucket: R2Bucket,
  prefix: string,
  maxBatches = MAX_R2_DELETE_BATCHES_PER_DELIVERY,
): Promise<number> {
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const listed = await bucket.list({ prefix, limit: R2_DELETE_BATCH_SIZE });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length === 0) return deleted;
    await bucket.delete(keys);
    deleted += keys.length;
  }

  const remaining = await bucket.list({ prefix, limit: 1 });
  if (remaining.objects.length > 0) {
    throw new IncompleteAssetPurgeError('Account asset purge needs another delivery');
  }
  return deleted;
}

async function resolveUserDeletionContext(
  env: Env,
  clerkUserId: string,
): Promise<{ internalUserId: string; stripeCustomerId: string | null }> {
  const user = await env.DB.prepare(
    'SELECT id, stripe_customer_id FROM users WHERE clerk_user_id = ?'
  ).bind(clerkUserId).first<{ id: string; stripe_customer_id: string | null }>();
  return {
    internalUserId: user?.id ?? clerkUserId,
    stripeCustomerId: user?.stripe_customer_id ?? null,
  };
}

export async function deleteStripeCustomerProfile(
  env: Env,
  stripeCustomerId: string | null,
): Promise<boolean> {
  if (!stripeCustomerId) return false;
  if (!/^cus_[A-Za-z0-9]+$/.test(stripeCustomerId)) {
    throw new Error('Stored Stripe Customer id is invalid');
  }
  const secret = env.STRIPE_SECRET_KEY?.trim() ?? '';
  const expectedAccountId = env.STRIPE_ACCOUNT_ID?.trim() ?? '';
  if (
    !/^sk_(live|test)_[A-Za-z0-9_]+$/i.test(secret) ||
    !/^acct_[A-Za-z0-9]+$/.test(expectedAccountId) ||
    (env.ENVIRONMENT === 'production' && !/^sk_live_/i.test(secret))
  ) {
    throw new Error('Stripe account deletion is not configured');
  }
  const headers = {
    Authorization: `Bearer ${secret}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  const accountResponse = await fetch('https://api.stripe.com/v1/account', {
    headers,
    signal: AbortSignal.timeout(STRIPE_FETCH_TIMEOUT_MS),
  });
  const account = await accountResponse.json().catch(() => ({})) as { id?: string };
  if (!accountResponse.ok || account.id !== expectedAccountId) {
    throw new Error('Stripe credentials do not match the configured Insert Player account');
  }

  const response = await fetch(
    `https://api.stripe.com/v1/customers/${encodeURIComponent(stripeCustomerId)}`,
    {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(STRIPE_FETCH_TIMEOUT_MS),
    },
  );
  if (response.status === 404) return true;
  const deleted = await response.json().catch(() => ({})) as { id?: string; deleted?: boolean };
  if (!response.ok || deleted.id !== stripeCustomerId || deleted.deleted !== true) {
    throw new Error('Stripe Customer deletion failed');
  }
  return true;
}

async function deleteClerkUserDatabaseRows(
  env: Env,
  clerkUserId: string,
  internalUserId: string,
  eventId: string,
): Promise<void> {
  const subjectHash = await hashString(clerkUserId);
  const rateLimitMarker = `:user:${internalUserId}:`;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO clerk_user_tombstones (subject_hash, webhook_event_id)
      VALUES (?, ?)
      ON CONFLICT(subject_hash) DO UPDATE SET
        webhook_event_id = excluded.webhook_event_id,
        deleted_at = datetime('now')
    `).bind(subjectHash, eventId),
    env.DB.prepare(`
      DELETE FROM matches
      WHERE player1_id = ? OR player2_id = ? OR winner_id = ?
        OR p1_fighter_id IN (SELECT id FROM fighters WHERE owner_user_id = ?)
        OR p2_fighter_id IN (SELECT id FROM fighters WHERE owner_user_id = ?)
        OR p1_character_id IN (SELECT id FROM characters WHERE user_id = ?)
        OR p2_character_id IN (SELECT id FROM characters WHERE user_id = ?)
    `).bind(
      internalUserId,
      internalUserId,
      internalUserId,
      internalUserId,
      internalUserId,
      internalUserId,
      internalUserId,
    ),
    env.DB.prepare('DELETE FROM rate_limits WHERE instr(key, ?) > 0').bind(rateLimitMarker),
    env.DB.prepare(`
      DELETE FROM stripe_events
      WHERE user_id = ? OR instr(payload, ?) > 0 OR instr(payload, ?) > 0
    `).bind(internalUserId, internalUserId, clerkUserId),
    env.DB.prepare('DELETE FROM users WHERE clerk_user_id = ?').bind(clerkUserId),
    env.DB.prepare(`
      INSERT OR IGNORE INTO clerk_webhook_events (id, event_type)
      VALUES (?, 'user.deleted')
    `).bind(eventId),
  ]);
}

export async function processClerkUserWebhook(
  event: UserWebhookEvent,
  eventId: string,
  env: Env,
): Promise<{
  outcome: 'synced' | 'deleted' | 'ignored_deleted';
  assetsDeleted?: number;
  stripeCustomerDeleted?: boolean;
}> {
  if (!validClerkUserId(event.data.id)) {
    throw new InvalidClerkWebhookPayloadError('Clerk user event is missing a valid id');
  }
  const clerkUserId = event.data.id;

  if (event.type === 'user.deleted') {
    const { internalUserId, stripeCustomerId } = await resolveUserDeletionContext(env, clerkUserId);
    let assetsDeleted = 0;
    for (const ownerId of new Set([clerkUserId, internalUserId])) {
      assetsDeleted += await purgeR2Prefix(env.SPRITES, `users/${ownerId}/`);
    }
    const stripeCustomerDeleted = await deleteStripeCustomerProfile(env, stripeCustomerId);
    await deleteClerkUserDatabaseRows(env, clerkUserId, internalUserId, eventId);
    return stripeCustomerDeleted
      ? { outcome: 'deleted', assetsDeleted, stripeCustomerDeleted }
      : { outcome: 'deleted', assetsDeleted };
  }

  if (await isClerkUserTombstoned(env, clerkUserId)) {
    await recordWebhookEvent(env, eventId, event.type);
    return { outcome: 'ignored_deleted' };
  }

  await upsertClerkUserProfile(env, clerkUserId, {
    displayName: webhookDisplayName(event.data),
    avatarUrl: event.data.image_url,
    email: primaryEmail(event.data),
  });
  await syncClerkAdminRole(env, clerkUserId, webhookGrantsAdmin(event.data));
  await recordWebhookEvent(env, eventId, event.type);
  return { outcome: 'synced' };
}

export async function handleClerkWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.CLERK_WEBHOOK_SIGNING_SECRET) {
    return json({ error: 'Clerk webhook is not configured' }, 503);
  }

  let event: WebhookEvent;
  try {
    const rawBody = await readRequestText(request, MAX_CLERK_WEBHOOK_BODY_BYTES);
    const verifiedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: rawBody,
    });
    event = await verifyWebhook(verifiedRequest, { signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: 'Request body is too large' }, 413);
    }
    return json({ error: 'Webhook verification failed' }, 400);
  }

  try {
    const eventId = requiredWebhookId(request);
    if (!isUserWebhookEvent(event)) {
      return json({ received: true, ignored: true });
    }
    if (await webhookWasProcessed(env, eventId)) {
      return json({ received: true, duplicate: true });
    }

    const result = await processClerkUserWebhook(event, eventId, env);
    return json({ received: true, ...result });
  } catch (error) {
    if (error instanceof InvalidClerkWebhookPayloadError) {
      return json({ error: 'Invalid Clerk webhook payload' }, 400);
    }
    if (error instanceof IncompleteAssetPurgeError) {
      return json({ error: 'Account deletion is still processing' }, 503);
    }
    console.error('Clerk webhook processing failed');
    return json({ error: 'Webhook processing failed' }, 500);
  }
}
