import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProductEventAggregates, getProductEventReport, submitProductEvent } from './productEvents';
import { RequestBodyTooLargeError } from './requestBody';
import type { AuthContext, Env } from './types';

const runtimes: Miniflare[] = [];
const migration = readFileSync(new NodeURL('../migrations/0045_product_event_aggregates.sql', import.meta.url), 'utf8');
const operationalSchema = `
  CREATE TABLE users (id TEXT, clerk_user_id TEXT, created_at TEXT);
  CREATE TABLE generation_charges (fighter_id TEXT, user_id TEXT, status TEXT, tier TEXT, reason TEXT, updated_at TEXT);
  CREATE TABLE generation_artifact_runs (fighter_id TEXT, user_id TEXT, status TEXT, tier TEXT, operation TEXT, created_at TEXT, completed_at TEXT);
  CREATE TABLE crew_referrals (invitee_user_id TEXT, created_at TEXT, membership_confirmed_at TEXT);
  CREATE TABLE crew_stages (status TEXT, updated_at TEXT);
  CREATE TABLE credit_ledger (user_id TEXT, stripe_session_id TEXT, reason TEXT, created_at TEXT);
`;
async function createEnv() {
  const mf = new Miniflare({ workers: [{ config: {
    type: 'worker', name: `product-events-${runtimes.length}`, compatibilityDate: '2026-08-24',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };' } } },
    env: { DB: { type: 'd1', id: `product-events-${runtimes.length}` } },
  } }] });
  runtimes.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch(`${migration}\n${operationalSchema}`.split(';').map(value => value.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  return { db, env: { DB: db, CORS_ORIGIN: 'https://insertplayer.ai' } as Env };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://api.insertplayer.ai/api/product-events', {
    method: 'POST', headers: { Origin: 'https://insertplayer.ai', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const admin = { userId: 'private-admin-id', user: { plan_tier: 'admin' } } as AuthContext;
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); });

describe('anonymous aggregate product measurement', () => {
  it('atomically aggregates repeated events and durations without storing event or identity rows', async () => {
    const { db, env } = await createEnv();
    await Promise.all([1000, 3000].map(durationMs => submitProductEvent(request({
      name: 'game_completed', userId: 'private-user', at: '1900-01-01',
      properties: { game: 'aura', source: 'trial', channel: 'instagram', durationMs, email: 'alice@example.com' },
    }), env)));
    await submitProductEvent(request({ name: 'game_completed', properties: { game: 'aura', source: 'trial', channel: 'instagram' } }), env);
    const rows = await db.prepare('SELECT * FROM product_event_daily').all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ event_count: 3, duration_count: 2, duration_ms_total: 4000 });
    expect(JSON.stringify(rows.results)).not.toMatch(/alice|private|1900/);
    const reportResponse = await getProductEventReport(new Request('https://api.insertplayer.ai/api/admin/product-events?days=7'), env, admin);
    const report = await reportResponse.json() as { events: unknown[]; operational: Record<string, number> };
    expect(report.events).toEqual([expect.objectContaining({ event: 'game_completed', eventCount: 3, durationSamples: 2, averageDurationMs: 2000 })]);
    expect(reportResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(report.operational.creditPurchases).toBe(0);
  });

  it('rejects oversized, untrusted, non-JSON and unknown events and honors privacy headers', async () => {
    const { db, env } = await createEnv();
    expect((await submitProductEvent(request({ name: 'game_started' }, { Origin: 'https://evil.example' }), env)).status).toBe(403);
    expect((await submitProductEvent(request({ name: 'game_started' }, { 'Content-Type': 'text/plain' }), env)).status).toBe(415);
    expect((await submitProductEvent(request({ name: 'private@example.com' }), env)).status).toBe(400);
    await expect(submitProductEvent(request({ name: 'game_started', value: 'x'.repeat(2048) }), env)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect((await submitProductEvent(request({ name: 'game_started' }, { DNT: '1' }), env)).status).toBe(204);
    expect((await submitProductEvent(request({ name: 'game_started' }, { 'Sec-GPC': '1' }), env)).status).toBe(204);
    expect((await db.prepare('SELECT * FROM product_event_daily').all()).results).toEqual([]);
  });

  it('keeps trusted completed transactions separate from spoofable client events and limits report access', async () => {
    const { db, env } = await createEnv();
    await db.batch([
      db.prepare("INSERT INTO users VALUES ('private-user', 'private-clerk', datetime('now'))"),
      db.prepare("INSERT INTO users VALUES ('system', NULL, datetime('now'))"),
      db.prepare("INSERT INTO generation_charges VALUES ('fighter', 'private-user', 'committed', 'rookie', 'fighter_generation', datetime('now'))"),
      db.prepare("INSERT INTO generation_charges VALUES ('failed-fighter', 'private-user', 'refunded', 'rookie', 'fighter_generation', datetime('now'))"),
      db.prepare("INSERT INTO generation_charges VALUES ('partial-fighter', 'private-user', 'committed', 'rookie', 'fighter_generation', datetime('now'))"),
      db.prepare("INSERT INTO generation_artifact_runs VALUES ('fighter', 'private-user', 'succeeded', 'rookie', 'fighter_generation', datetime('now', '-1 minute'), datetime('now'))"),
      db.prepare("INSERT INTO generation_artifact_runs VALUES ('partial-fighter', 'private-user', 'partial', 'rookie', 'fighter_generation', datetime('now'), NULL)"),
      db.prepare("INSERT INTO crew_referrals VALUES ('private-user', datetime('now'), datetime('now'))"),
      db.prepare("INSERT INTO crew_referrals VALUES (NULL, datetime('now'), NULL)"),
      db.prepare("INSERT INTO crew_stages VALUES ('ready', datetime('now'))"),
      db.prepare("INSERT INTO crew_stages VALUES ('reserved', datetime('now'))"),
      db.prepare("INSERT INTO credit_ledger VALUES ('private-user', 'private-stripe-session', 'stripe_credit_pack:starter', datetime('now'))"),
      db.prepare("INSERT INTO credit_ledger VALUES ('private-user', NULL, 'manual_adjustment', datetime('now'))"),
    ]);
    const url = 'https://api.insertplayer.ai/api/admin/product-events';
    expect((await getProductEventReport(new Request(url), env, { ...admin, user: { plan_tier: 'free' } } as AuthContext)).status).toBe(403);
    for (const days of ['0', '91', '30.5', 'NaN', '1 OR 1']) {
      expect((await getProductEventReport(new Request(`${url}?days=${encodeURIComponent(days)}`), env, admin)).status).toBe(400);
    }
    const report = await (await getProductEventReport(new Request(`${url}?days=90`), env, admin)).json() as { operational: Record<string, number> };
    expect(report.operational).toEqual({ accountsCreated: 1, rookieFightersCommitted: 2, rookieFightersReady: 1, rookieCreators: 1, rookieAverageCreationMs: 60000, invitesCreated: 2, invitesAccepted: 1, playersJoined: 1, crewStagesReady: 1, creditPurchases: 1, payingPlayers: 1 });
    expect(JSON.stringify(report)).not.toMatch(/private-user|private-clerk|private-stripe|fighter"/);
  });

  it('expires only aggregates outside the 90-day UTC window', async () => {
    const { db, env } = await createEnv();
    for (const age of [0, 89, 90]) {
      await db.prepare("INSERT INTO product_event_daily VALUES (date('now', ?), 'game_started', 'direct', 'trial', 'aura', 'unknown', 1, 0, 0)").bind(`-${age} days`).run();
    }
    await cleanupProductEventAggregates(env);
    expect((await db.prepare('SELECT * FROM product_event_daily').all()).results).toHaveLength(2);
  });
});
