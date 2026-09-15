import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createOrganizationInvitation,
  getClerkOrganization,
  getClerkUser,
  getClerkUserList,
} = vi.hoisted(() => ({
  createOrganizationInvitation: vi.fn(),
  getClerkOrganization: vi.fn(),
  getClerkUser: vi.fn(),
  getClerkUserList: vi.fn(),
}));

vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    users: { getUser: getClerkUser, getUserList: getClerkUserList },
    organizations: {
      createOrganizationInvitation,
      getOrganization: getClerkOrganization,
    },
  }),
}));

import { AURA_ANIMATION_NAMES } from './fighterAssetPacks';
import {
  createCrewInvitation,
  getOnboardingStatus,
  getReferralLanding,
  recordOnboardingDebut,
  referralRookiePasses,
} from './referrals';
import type { AuthContext, Env } from './types';

const INVITER_ID = '11111111111111111111111111111111';
const INVITEE_ID = '22222222222222222222222222222222';
const SECOND_INVITEE_ID = '33333333333333333333333333333333';
const FIGHTER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_FIGHTER_ID = 'cccccccccccccccccccccccccccccccc';
const REFERRAL_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SECOND_REFERRAL_ID = 'dddddddddddddddddddddddddddddddd';
const ORGANIZATION_ID = 'org_crew_alpha';

const SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    clerk_user_id TEXT,
    display_name TEXT NOT NULL
  );

  CREATE TABLE fighters (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    photo_hash TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    public_flag INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sprites (
    id TEXT PRIMARY KEY,
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT,
    frame_w INTEGER NOT NULL,
    frame_h INTEGER NOT NULL,
    frame_count INTEGER NOT NULL
  );

  CREATE TABLE arcade_fighters (
    fighter_id TEXT PRIMARY KEY REFERENCES fighters(id) ON DELETE CASCADE
  );

  CREATE TABLE fighter_group_grants (
    fighter_id TEXT NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
    clerk_organization_id TEXT NOT NULL,
    granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (fighter_id, clerk_organization_id)
  );

  CREATE TABLE crew_referrals (
    id TEXT PRIMARY KEY,
    clerk_invitation_id TEXT UNIQUE,
    clerk_organization_id TEXT NOT NULL,
    inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    invited_email_hmac TEXT NOT NULL,
    oauth_identity_hmac TEXT UNIQUE,
    crew_name TEXT NOT NULL,
    inviter_display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    accepted_at TEXT,
    qualified_at TEXT,
    rewarded_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX idx_crew_referrals_rewarded_invitee
    ON crew_referrals(invitee_user_id)
    WHERE invitee_user_id IS NOT NULL AND status IN ('qualified', 'rewarded', 'capped');

  CREATE TABLE fighter_entitlements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unused',
    source_referral_id TEXT NOT NULL UNIQUE REFERENCES crew_referrals(id) ON DELETE CASCADE,
    reserved_charge_id TEXT UNIQUE,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const runtimes: Miniflare[] = [];

async function createBindings(): Promise<{ db: D1Database; env: Env }> {
  const mf = new Miniflare({
    workers: [{
      config: {
        type: 'worker',
        name: `referrals-${runtimes.length}`,
        compatibilityDate: '2026-08-24',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents: 'export default { fetch() { return new Response("ok"); } };',
            },
          },
        },
        env: { DB: { type: 'd1', id: `referrals-${runtimes.length}` } },
      },
    }],
  });
  runtimes.push(mf);
  const db = await mf.getD1Database('DB');
  await db.batch(SCHEMA
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));
  return {
    db,
    env: {
      DB: db,
      ENVIRONMENT: 'development',
      ANONYMIZATION_SECRET: 'referral-test-secret-that-is-long-enough',
      CLERK_SECRET_KEY: 'sk_test_referrals',
    } as unknown as Env,
  };
}

function auth(
  userId = INVITEE_ID,
  fighterId = FIGHTER_ID,
  role = 'org:member',
): AuthContext {
  return {
    userId,
    claims: {},
    activeOrganizationId: ORGANIZATION_ID,
    activeOrganizationSlug: 'alpha',
    activeOrganizationRole: role,
    user: {
      id: userId,
      clerk_user_id: `clerk_${userId}`,
      display_name: `Player ${fighterId.slice(0, 2)}`,
    },
  } as AuthContext;
}

function debutRequest(fighterId: string): Request {
  return new Request('https://api.insertplayer.ai/api/onboarding/debut', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fighterId }),
  });
}

function auraSprites(db: D1Database, fighterId: string, offset: number): D1PreparedStatement[] {
  return AURA_ANIMATION_NAMES.map((animationName, index) => db.prepare(`
    INSERT INTO sprites (
      id, fighter_id, animation_name, quality_tier, blob_key, content_hash,
      frame_w, frame_h, frame_count
    ) VALUES (?, ?, ?, 'rookie', ?, ?, 256, 256, 6)
  `).bind(
    `${fighterId.slice(0, 24)}${String(index + offset).padStart(8, '0')}`,
    fighterId,
    animationName,
    `users/${fighterId}/sprites/${animationName}.png`,
    String(index + offset).padStart(64, 'a').slice(-64),
  ));
}

beforeEach(() => {
  createOrganizationInvitation.mockReset();
  getClerkOrganization.mockReset();
  getClerkUser.mockReset();
  getClerkUserList.mockReset();
  getClerkUser.mockResolvedValue({
    externalAccounts: [{
      provider: 'oauth_google',
      providerUserId: 'stable-google-user',
      verification: { status: 'verified' },
    }],
  });
  getClerkUserList.mockResolvedValue({ data: [] });
  getClerkOrganization.mockResolvedValue({ name: 'Alpha Crew' });
  createOrganizationInvitation.mockResolvedValue({
    id: 'orginv_alpha',
    expiresAt: Date.now() + 30 * 86_400_000,
  });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('Crew referral qualification', () => {
  it('creates the invitation server-side only for a new email and stores no raw address', async () => {
    const { db, env } = await createBindings();
    await db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
      .bind(INVITER_ID, `clerk_${INVITER_ID}`, 'Inviter').run();
    const request = new Request('https://api.insertplayer.ai/api/crew/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ' New.Player+Crew@Example.com ' }),
    });
    const response = await createCrewInvitation(
      request,
      env,
      auth(INVITER_ID, FIGHTER_ID, 'org:admin'),
    );

    expect(response.status).toBe(201);
    expect(getClerkUserList).toHaveBeenCalledWith({
      emailAddress: ['new.player+crew@example.com'],
      limit: 1,
    });
    expect(createOrganizationInvitation).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORGANIZATION_ID,
      inviterUserId: `clerk_${INVITER_ID}`,
      emailAddress: 'new.player+crew@example.com',
      role: 'org:member',
    }));
    const stored = await db.prepare(`
      SELECT clerk_invitation_id, invited_email_hmac, crew_name, inviter_display_name
      FROM crew_referrals LIMIT 1
    `).first<{
      clerk_invitation_id: string;
      invited_email_hmac: string;
      crew_name: string;
      inviter_display_name: string;
    }>();
    expect(stored).toMatchObject({
      clerk_invitation_id: 'orginv_alpha',
      crew_name: 'Alpha Crew',
      inviter_display_name: 'Player aa',
    });
    expect(stored?.invited_email_hmac).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('new.player');
  });

  it('rejects a referral when Clerk already has an account for that email', async () => {
    const { db, env } = await createBindings();
    await db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
      .bind(INVITER_ID, `clerk_${INVITER_ID}`, 'Inviter').run();
    getClerkUserList.mockResolvedValueOnce({ data: [{ id: 'user_already_here' }] });
    const response = await createCrewInvitation(
      new Request('https://api.insertplayer.ai/api/crew/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'existing@example.com' }),
      }),
      env,
      auth(INVITER_ID, FIGHTER_ID, 'org:admin'),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'account_already_exists' });
    expect(createOrganizationInvitation).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crew_referrals').first()).toEqual({ count: 0 });
  });

  it('lets Crew members finish after sharing while Crew admins receive the invite mission', async () => {
    const { db, env } = await createBindings();
    await db.batch([
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(INVITEE_ID, `clerk_${INVITEE_ID}`, 'Crew Player'),
      db.prepare(`
        INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
        VALUES (?, ?, 'Crew Rookie', 'crew-photo', 'rookie')
      `).bind(FIGHTER_ID, INVITEE_ID),
      ...auraSprites(db, FIGHTER_ID, 70),
      db.prepare(`
        INSERT INTO fighter_group_grants (fighter_id, clerk_organization_id, granted_by_user_id)
        VALUES (?, ?, ?)
      `).bind(FIGHTER_ID, ORGANIZATION_ID, INVITEE_ID),
    ]);

    const memberStatus = await getOnboardingStatus(env, auth());
    expect(await memberStatus.json()).toMatchObject({
      invitesSent: 0,
      sharedWithActiveCrew: true,
      canInviteCrew: false,
      recommendedStep: 'complete',
      complete: true,
    });

    const adminBeforeInvite = await getOnboardingStatus(env, auth(INVITEE_ID, FIGHTER_ID, 'org:admin'));
    expect(await adminBeforeInvite.json()).toMatchObject({
      invitesSent: 0,
      sharedWithActiveCrew: true,
      canInviteCrew: true,
      recommendedStep: 'invite',
      complete: false,
    });

    await db.prepare(`
      INSERT INTO crew_referrals (
        id, clerk_organization_id, inviter_user_id, invited_email_hmac,
        crew_name, inviter_display_name, status, expires_at
      ) VALUES (?, ?, ?, 'admin-invite-email-hmac', 'Alpha Crew', 'Crew Player',
        'pending', datetime('now', '+30 days'))
    `).bind(REFERRAL_ID, ORGANIZATION_ID, INVITEE_ID).run();
    const adminAfterInvite = await getOnboardingStatus(env, auth(INVITEE_ID, FIGHTER_ID, 'org:admin'));
    expect(await adminAfterInvite.json()).toMatchObject({
      invitesSent: 1,
      canInviteCrew: true,
      recommendedStep: 'complete',
      complete: true,
    });
  }, 15_000);

  it('requires the complete Rookie Aura pack, rewards once, and blocks reused social identities', async () => {
    const { db, env } = await createBindings();
    await db.batch([
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(INVITER_ID, `clerk_${INVITER_ID}`, 'Inviter'),
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(INVITEE_ID, `clerk_${INVITEE_ID}`, 'Invitee'),
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(SECOND_INVITEE_ID, `clerk_${SECOND_INVITEE_ID}`, 'Second Invitee'),
      db.prepare(`
        INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
        VALUES (?, ?, 'Rookie One', 'photo-one', 'rookie')
      `).bind(FIGHTER_ID, INVITEE_ID),
      db.prepare(`
        INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
        VALUES (?, ?, 'Rookie Two', 'photo-two', 'rookie')
      `).bind(SECOND_FIGHTER_ID, SECOND_INVITEE_ID),
      db.prepare(`
        INSERT INTO crew_referrals (
          id, clerk_invitation_id, clerk_organization_id, inviter_user_id,
          invitee_user_id, invited_email_hmac, crew_name, inviter_display_name,
          status, accepted_at, expires_at
        ) VALUES (?, 'invitation-one', ?, ?, ?, 'email-hmac-one', 'Alpha Crew',
          'Inviter', 'accepted', datetime('now'), datetime('now', '+30 days'))
      `).bind(REFERRAL_ID, ORGANIZATION_ID, INVITER_ID, INVITEE_ID),
      db.prepare(`
        INSERT INTO crew_referrals (
          id, clerk_invitation_id, clerk_organization_id, inviter_user_id,
          invitee_user_id, invited_email_hmac, crew_name, inviter_display_name,
          status, accepted_at, expires_at
        ) VALUES (?, 'invitation-two', ?, ?, ?, 'email-hmac-two', 'Alpha Crew',
          'Inviter', 'accepted', datetime('now'), datetime('now', '+30 days'))
      `).bind(SECOND_REFERRAL_ID, ORGANIZATION_ID, INVITER_ID, SECOND_INVITEE_ID),
    ]);

    const incomplete = await recordOnboardingDebut(debutRequest(FIGHTER_ID), env, auth());
    expect(incomplete.status).toBe(403);
    expect(getClerkUser).not.toHaveBeenCalled();

    await db.batch([
      ...auraSprites(db, FIGHTER_ID, 10),
      ...auraSprites(db, SECOND_FIGHTER_ID, 30),
    ]);
    const qualified = await recordOnboardingDebut(debutRequest(FIGHTER_ID), env, auth());
    expect(qualified.status).toBe(200);
    expect(await qualified.json()).toEqual({
      recorded: true,
      referralQualified: true,
      rewardGranted: true,
    });
    expect(await referralRookiePasses(env, INVITER_ID)).toBe(1);
    expect(await db.prepare('SELECT status FROM crew_referrals WHERE id = ?')
      .bind(REFERRAL_ID).first()).toEqual({ status: 'rewarded' });

    const replay = await recordOnboardingDebut(debutRequest(FIGHTER_ID), env, auth());
    expect(await replay.json()).toEqual({
      recorded: true,
      referralQualified: true,
      rewardGranted: true,
    });
    expect(await referralRookiePasses(env, INVITER_ID)).toBe(1);

    const reusedIdentity = await recordOnboardingDebut(
      debutRequest(SECOND_FIGHTER_ID),
      env,
      auth(SECOND_INVITEE_ID, SECOND_FIGHTER_ID),
    );
    expect(reusedIdentity.status).toBe(409);
    expect(await reusedIdentity.json()).toEqual({
      error: 'This social account has already qualified a referral',
    });
    expect(await db.prepare('SELECT status FROM crew_referrals WHERE id = ?')
      .bind(SECOND_REFERRAL_ID).first()).toEqual({ status: 'accepted' });
    expect(await referralRookiePasses(env, INVITER_ID)).toBe(1);

    const landing = await getReferralLanding(env, REFERRAL_ID);
    expect(await landing.json()).toEqual({
      invitation: {
        id: REFERRAL_ID,
        organizationId: ORGANIZATION_ID,
        crewName: 'Alpha Crew',
        inviterName: 'Inviter',
        status: 'rewarded',
      },
    });
  }, 15_000);
});
