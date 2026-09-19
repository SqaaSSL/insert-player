import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationInvitationAcceptedWebhookEvent, OrganizationMembershipWebhookEvent } from '@clerk/backend/webhooks';

const {
  createOrganizationMembership,
  createOrganizationInvitation,
  getClerkOrganization,
  getOrganizationMembershipList,
  getClerkUser,
  getClerkUserList,
} = vi.hoisted(() => ({
  createOrganizationMembership: vi.fn(),
  createOrganizationInvitation: vi.fn(),
  getClerkOrganization: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
  getClerkUser: vi.fn(),
  getClerkUserList: vi.fn(),
}));

vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    users: { getUser: getClerkUser, getUserList: getClerkUserList },
    organizations: {
      createOrganizationMembership,
      createOrganizationInvitation,
      getOrganization: getClerkOrganization,
      getOrganizationMembershipList,
    },
  }),
}));

import { AURA_ANIMATION_NAMES } from './fighterAssetPacks';
import {
  acceptCrewInviteLink,
  acceptReferralWebhook,
  createCrewInviteLink,
  createCrewInvitation,
  getOnboardingStatus,
  getReferralLanding,
  recordOnboardingDebut,
  recordOnboardingTrial,
  referralRookiePasses,
  revokeCrewWebhook,
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
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    email TEXT,
    oauth_provider TEXT,
    oauth_id TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE clerk_user_tombstones (subject_hash TEXT PRIMARY KEY);

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
    invite_channel TEXT NOT NULL DEFAULT 'email',
    reward_eligible INTEGER NOT NULL DEFAULT 1,
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

  CREATE TABLE crew_stages (
    clerk_organization_id TEXT PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    generation_charge_id TEXT,
    status TEXT NOT NULL DEFAULT 'reserved',
    label TEXT NOT NULL DEFAULT 'CREW STAGE',
    kind TEXT,
    blob_key TEXT,
    content_hash TEXT,
    source_json TEXT,
    reservation_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const runtimes: Miniflare[] = [];

async function applyProgressMigration(db: D1Database): Promise<void> {
  const sql = readFileSync(new NodeURL('../migrations/0044_onboarding_progress.sql', import.meta.url), 'utf8');
  await db.batch(sql.replace(/^\s*--.*$/gm, '').split(';')
    .map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
}

async function createBindings(migrateProgress = true): Promise<{ db: D1Database; env: Env }> {
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
  if (migrateProgress) await applyProgressMigration(db);
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
  createOrganizationMembership.mockReset();
  createOrganizationInvitation.mockReset();
  getClerkOrganization.mockReset();
  getOrganizationMembershipList.mockReset();
  getClerkUser.mockReset();
  getClerkUserList.mockReset();
  getClerkUser.mockResolvedValue({
    id: `clerk_${INVITEE_ID}`,
    createdAt: Date.now(),
    externalAccounts: [{
      provider: 'oauth_google',
      providerUserId: 'stable-google-user',
      verification: { status: 'verified' },
    }],
  });
  getClerkUserList.mockResolvedValue({ data: [] });
  getOrganizationMembershipList.mockResolvedValue({ data: [] });
  createOrganizationMembership.mockResolvedValue({ id: 'orgmem_alpha' });
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

  it('creates a reusable one-time link for WhatsApp without asking Clerk to send email', async () => {
    const { db, env } = await createBindings();
    await db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
      .bind(INVITER_ID, `clerk_${INVITER_ID}`, 'Inviter').run();

    const first = await createCrewInviteLink(env, auth(INVITER_ID, FIGHTER_ID, 'org:admin'));
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { invitation: { id: string; url: string } };
    expect(firstBody.invitation.url).toBe(`https://insertplayer.ai/join?referral=${firstBody.invitation.id}`);
    expect(createOrganizationInvitation).not.toHaveBeenCalled();

    const second = await createCrewInviteLink(env, auth(INVITER_ID, FIGHTER_ID, 'org:admin'));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ invitation: { id: firstBody.invitation.id } });
    expect(await db.prepare(`
      SELECT invite_channel, status, clerk_invitation_id FROM crew_referrals WHERE id = ?
    `).bind(firstBody.invitation.id).first()).toEqual({
      invite_channel: 'link',
      status: 'pending',
      clerk_invitation_id: null,
    });
  });

  it('lets the first verified Player Two claim the link and joins the Clerk Organization directly', async () => {
    const { db, env } = await createBindings();
    await db.batch([
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(INVITER_ID, `clerk_${INVITER_ID}`, 'Inviter'),
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(INVITEE_ID, `clerk_${INVITEE_ID}`, 'Invitee'),
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(SECOND_INVITEE_ID, `clerk_${SECOND_INVITEE_ID}`, 'Late Player'),
    ]);
    const created = await createCrewInviteLink(env, auth(INVITER_ID, FIGHTER_ID, 'org:admin'));
    const { invitation } = await created.json() as { invitation: { id: string } };
    getClerkUser.mockResolvedValueOnce({
      id: `clerk_${INVITEE_ID}`,
      createdAt: Date.now() + 1_000,
      externalAccounts: [{
        provider: 'oauth_google',
        providerUserId: 'stable-google-user',
        verification: { status: 'verified' },
      }],
    });

    const accepted = await acceptCrewInviteLink(env, auth(), invitation.id);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      invitation: { id: invitation.id, organizationId: ORGANIZATION_ID, status: 'accepted' },
      reward: { eligible: true, pending: true },
    });
    expect(createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      userId: `clerk_${INVITEE_ID}`,
      role: 'org:member',
    });
    expect(await db.prepare(`
      SELECT invitee_user_id, status, reward_eligible, oauth_identity_hmac, membership_confirmed_at
      FROM crew_referrals WHERE id = ?
    `).bind(invitation.id).first()).toMatchObject({
      invitee_user_id: INVITEE_ID,
      status: 'accepted',
      reward_eligible: 1,
      oauth_identity_hmac: expect.stringMatching(/^[a-f0-9]{64}$/),
      membership_confirmed_at: expect.any(String),
    });

    const late = await acceptCrewInviteLink(
      env,
      auth(SECOND_INVITEE_ID, SECOND_FIGHTER_ID),
      invitation.id,
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: 'invite_claimed' });
  });

  it('allows an existing verified player to join without granting a referral reward', async () => {
    const { db, env } = await createBindings();
    await db.batch([
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(INVITER_ID, `clerk_${INVITER_ID}`, 'Inviter'),
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(INVITEE_ID, `clerk_${INVITEE_ID}`, 'Existing Player'),
    ]);
    const created = await createCrewInviteLink(env, auth(INVITER_ID, FIGHTER_ID, 'org:admin'));
    const { invitation } = await created.json() as { invitation: { id: string } };
    getClerkUser.mockResolvedValueOnce({
      id: `clerk_${INVITEE_ID}`,
      createdAt: Date.now() - 86_400_000,
      externalAccounts: [{
        provider: 'oauth_google',
        providerUserId: 'existing-google-player',
        verification: { status: 'verified' },
      }],
    });

    const accepted = await acceptCrewInviteLink(env, auth(), invitation.id);
    expect(await accepted.json()).toMatchObject({ reward: { eligible: false, pending: false } });
    expect(await db.prepare('SELECT reward_eligible, oauth_identity_hmac FROM crew_referrals WHERE id = ?')
      .bind(invitation.id).first()).toEqual({ reward_eligible: 0, oauth_identity_hmac: null });
  });

  it('lets members finish while Crew admins invite first and then lock one shared stage', async () => {
    const { db, env } = await createBindings();
    await db.batch([
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(INVITEE_ID, `clerk_${INVITEE_ID}`, 'Crew Player'),
      db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
        .bind(SECOND_INVITEE_ID, `clerk_${SECOND_INVITEE_ID}`, 'Player Two'),
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

    expect(await (await getOnboardingStatus(env, auth())).json()).toMatchObject({
      recommendedStep: 'debut', debutComplete: false, complete: false,
    });
    await recordOnboardingDebut(debutRequest(FIGHTER_ID), env, auth());
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
      crewStageReady: false,
      crewStageState: 'available',
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
      invitesAccepted: 0,
      canInviteCrew: true,
      crewStageReady: false,
      recommendedStep: 'invite',
      complete: false,
    });

    await db.prepare(`
      UPDATE crew_referrals
      SET status = 'accepted', invitee_user_id = ?, accepted_at = datetime('now')
      WHERE id = ?
    `).bind(SECOND_INVITEE_ID, REFERRAL_ID).run();
    getOrganizationMembershipList.mockResolvedValue({ data: [{ id: 'orgmem_player_two' }] });
    const adminAfterAcceptance = await getOnboardingStatus(env, auth(INVITEE_ID, FIGHTER_ID, 'org:admin'));
    expect(await adminAfterAcceptance.json()).toMatchObject({
      invitesSent: 1,
      invitesAccepted: 1,
      recommendedStep: 'stage',
      complete: false,
    });

    await db.prepare(`
      INSERT INTO crew_stages (
        clerk_organization_id, id, created_by_user_id, status, label,
        kind, blob_key, content_hash
      ) VALUES (?, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', ?, 'ready',
        'THE OLD PARK', 'photo', 'crews/alpha/stage.png', ?)
    `).bind(ORGANIZATION_ID, INVITEE_ID, 'e'.repeat(64)).run();
    const adminComplete = await getOnboardingStatus(env, auth(INVITEE_ID, FIGHTER_ID, 'org:admin'));
    expect(await adminComplete.json()).toMatchObject({
      invitesSent: 1,
      invitesAccepted: 1,
      sharedWithActiveCrew: true,
      canInviteCrew: true,
      crewStageReady: true,
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
    expect(await qualified.json()).toEqual({ recorded: true, referralQualified: false, reason: 'crew_not_active' });
    expect(await referralRookiePasses(env, INVITER_ID)).toBe(0);
    getOrganizationMembershipList.mockResolvedValue({ data: [{ id: 'orgmem_player_two' }] });
    const joinedAndQualified = await recordOnboardingDebut(debutRequest(FIGHTER_ID), env, auth());
    expect(joinedAndQualified.status).toBe(200);
    expect(await joinedAndQualified.json()).toEqual({
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
        inviteChannel: 'email',
      },
    });
  }, 15_000);

  it('persists trial and owned-character debut without a referral, idempotently and only for the signed-in account', async () => {
    const { db, env } = await createBindings();
    await db.batch([INVITEE_ID, INVITER_ID].map((id) => db.prepare(
      'INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)'
    ).bind(id, `clerk_${id}`, 'Player')));
    const player = { ...auth(), activeOrganizationId: null };
    expect(await (await getOnboardingStatus(env, player)).json()).toMatchObject({
      trialComplete: false, debutComplete: false, recommendedStep: 'create',
    });
    const trial = () => new Request('https://api.insertplayer.ai/api/onboarding/trial', {
      method: 'POST', body: JSON.stringify({ userId: INVITER_ID }),
    });
    await recordOnboardingTrial(trial(), env, player);
    expect(await db.prepare('SELECT user_id FROM user_onboarding_progress').all()).toMatchObject({
      results: [{ user_id: INVITEE_ID }],
    });
    await db.batch([
      db.prepare(`INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier)
        VALUES (?, ?, 'First Rookie', 'progress-photo', 'rookie')`).bind(FIGHTER_ID, INVITEE_ID),
      ...auraSprites(db, FIGHTER_ID, 100),
    ]);
    expect(await (await getOnboardingStatus(env, player)).json()).toMatchObject({
      trialComplete: true, debutComplete: false, recommendedStep: 'debut',
    });
    const crossAccount = await recordOnboardingDebut(debutRequest(FIGHTER_ID), env, auth(INVITER_ID));
    expect(crossAccount.status).toBe(403);
    const debuted = await recordOnboardingDebut(debutRequest(FIGHTER_ID), env, player);
    expect(await debuted.json()).toEqual({ recorded: true, referralQualified: false });
    expect(await (await getOnboardingStatus(env, player)).json()).toMatchObject({
      trialComplete: true, debutComplete: true, recommendedStep: 'crew',
    });
    await db.prepare(`UPDATE user_onboarding_progress SET trial_completed_at = '2026-09-01 10:00:00',
      debut_completed_at = '2026-09-01 11:00:00' WHERE user_id = ?`).bind(INVITEE_ID).run();
    await Promise.all([
      recordOnboardingTrial(trial(), env, player),
      recordOnboardingDebut(debutRequest(FIGHTER_ID), env, player),
      recordOnboardingDebut(debutRequest(FIGHTER_ID), env, player),
    ]);
    expect((await db.prepare('SELECT * FROM user_onboarding_progress').all()).results).toEqual([{
      user_id: INVITEE_ID, debut_fighter_id: FIGHTER_ID,
      trial_completed_at: '2026-09-01 10:00:00', debut_completed_at: '2026-09-01 11:00:00',
    }]);
    expect(await (await getOnboardingStatus(env, auth(INVITER_ID))).json()).toMatchObject({
      trialComplete: false, debutComplete: false, fighter: null,
    });
  });

  it('does not mark a claimed link joined until Clerk membership succeeds and can safely retry the same invite', async () => {
    const { db, env } = await createBindings();
    await db.batch([INVITER_ID, INVITEE_ID].map((id) => db.prepare(
      'INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)'
    ).bind(id, `clerk_${id}`, 'Player')));
    const admin = auth(INVITER_ID, FIGHTER_ID, 'org:admin');
    const created = await createCrewInviteLink(env, admin);
    const { invitation } = await created.json() as { invitation: { id: string } };
    expect(await (await getReferralLanding(env, invitation.id)).json()).toMatchObject({
      invitation: { inviteChannel: 'link' },
    });
    createOrganizationMembership.mockRejectedValueOnce(new Error('Clerk temporarily unavailable'));
    await expect(acceptCrewInviteLink(env, auth(), invitation.id)).rejects.toThrow('Clerk temporarily unavailable');
    expect(await db.prepare('SELECT status, membership_confirmed_at FROM crew_referrals WHERE id = ?')
      .bind(invitation.id).first()).toEqual({ status: 'accepted', membership_confirmed_at: null });
    expect(await (await getOnboardingStatus(env, admin)).json()).toMatchObject({ invitesAccepted: 0 });
    getOrganizationMembershipList.mockResolvedValue({ data: [{ id: 'real_member' }] });
    expect((await acceptCrewInviteLink(env, auth(), invitation.id)).status).toBe(200);
    expect(await db.prepare('SELECT membership_confirmed_at FROM crew_referrals WHERE id = ?')
      .bind(invitation.id).first()).toEqual({ membership_confirmed_at: expect.any(String) });
    await db.prepare(`UPDATE crew_referrals SET membership_confirmed_at = '2026-09-01 12:00:00' WHERE id = ?`)
      .bind(invitation.id).run();
    expect((await acceptCrewInviteLink(env, auth(), invitation.id)).status).toBe(200);
    expect(await db.prepare('SELECT membership_confirmed_at FROM crew_referrals WHERE id = ?')
      .bind(invitation.id).first()).toEqual({ membership_confirmed_at: '2026-09-01 12:00:00' });
    expect(await (await getOnboardingStatus(env, admin)).json()).toMatchObject({ invitesAccepted: 1 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crew_referrals').first()).toEqual({ count: 1 });
  });

  it('confirms legacy acceptance only for a verified live member and clears even rewarded memberships on deletion', async () => {
    const { db, env } = await createBindings();
    await db.prepare('INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)')
      .bind(INVITER_ID, `clerk_${INVITER_ID}`, 'Inviter').run();
    const admin = auth(INVITER_ID, FIGHTER_ID, 'org:admin');
    const created = await createCrewInvitation(new Request('https://api.insertplayer.ai/api/crew/invitations', {
      method: 'POST', body: JSON.stringify({ email: 'player@example.com' }),
    }), env, admin);
    const { invitation } = await created.json() as { invitation: { id: string } };
    const webhook = { type: 'organizationInvitation.accepted', data: {
      id: 'orginv_alpha', organization_id: ORGANIZATION_ID, user_id: 'clerk_webhook_player',
      private_metadata: { insert_player_referral_id: invitation.id },
    } } as unknown as OrganizationInvitationAcceptedWebhookEvent;
    const clerkPlayer = {
      id: 'clerk_webhook_player', createdAt: Date.now(), emailAddresses: [], primaryEmailAddressId: null,
      firstName: 'Player', lastName: 'Two', imageUrl: null, externalAccounts: [],
    };
    getClerkUser.mockResolvedValue(clerkPlayer);
    getOrganizationMembershipList.mockResolvedValue({ data: [{ id: 'member_legacy' }] });
    expect(await acceptReferralWebhook(webhook, env)).toBe(true);
    expect(await db.prepare('SELECT membership_confirmed_at FROM crew_referrals WHERE id = ?')
      .bind(invitation.id).first()).toEqual({ membership_confirmed_at: null });
    getClerkUser.mockResolvedValue({ ...clerkPlayer, externalAccounts: [{
      provider: 'oauth_google', providerUserId: 'stable-webhook-google', verification: { status: 'verified' },
    }] });
    getOrganizationMembershipList.mockResolvedValue({ data: [] });
    await acceptReferralWebhook(webhook, env);
    expect(await db.prepare('SELECT membership_confirmed_at FROM crew_referrals WHERE id = ?')
      .bind(invitation.id).first()).toEqual({ membership_confirmed_at: null });
    getOrganizationMembershipList.mockResolvedValue({ data: [{ id: 'member_legacy' }] });
    await acceptReferralWebhook(webhook, env);
    expect(await db.prepare('SELECT membership_confirmed_at FROM crew_referrals WHERE id = ?')
      .bind(invitation.id).first()).toEqual({ membership_confirmed_at: expect.any(String) });
    await db.prepare(`UPDATE crew_referrals SET status = 'rewarded', qualified_at = datetime('now') WHERE id = ?`)
      .bind(invitation.id).run();
    expect(await (await getOnboardingStatus(env, admin)).json()).toMatchObject({ invitesAccepted: 1 });
    const deletion = { type: 'organizationMembership.deleted', data: {
      organization: { id: ORGANIZATION_ID }, public_user_data: { user_id: 'clerk_webhook_player' },
    } } as OrganizationMembershipWebhookEvent;
    expect(await revokeCrewWebhook(deletion, env)).toBe(true);
    expect(await db.prepare('SELECT status, membership_confirmed_at, qualified_at FROM crew_referrals WHERE id = ?')
      .bind(invitation.id).first()).toEqual({ status: 'rewarded', membership_confirmed_at: null, qualified_at: expect.any(String) });
    getOrganizationMembershipList.mockResolvedValue({ data: [] });
    expect(await (await getOnboardingStatus(env, admin)).json()).toMatchObject({ invitesAccepted: 0 });
    getOrganizationMembershipList.mockRejectedValue(new Error('Clerk unavailable'));
    expect(await (await getOnboardingStatus(env, admin)).json()).toMatchObject({
      invitesAccepted: 0, crewMembershipVerificationUnavailable: true,
    });
  });

  it('migrates proven historical debut progress without claiming historical Crew membership', async () => {
    const { db } = await createBindings(false);
    await db.batch([INVITER_ID, INVITEE_ID, SECOND_INVITEE_ID].map((id) => db.prepare(
      'INSERT INTO users (id, clerk_user_id, display_name) VALUES (?, ?, ?)'
    ).bind(id, `clerk_${id}`, 'Player')));
    await db.batch([
      db.prepare(`INSERT INTO crew_referrals (id, clerk_organization_id, inviter_user_id, invitee_user_id,
        invited_email_hmac, crew_name, inviter_display_name, status, qualified_at, expires_at)
        VALUES (?, ?, ?, ?, 'one', 'Alpha', 'Inviter', 'rewarded', '2026-09-01 12:00:00', datetime('now', '+30 days'))`)
        .bind(REFERRAL_ID, ORGANIZATION_ID, INVITER_ID, INVITEE_ID),
      db.prepare(`INSERT INTO crew_referrals (id, clerk_organization_id, inviter_user_id, invitee_user_id,
        invited_email_hmac, crew_name, inviter_display_name, status, expires_at)
        VALUES (?, ?, ?, ?, 'two', 'Alpha', 'Inviter', 'accepted', datetime('now', '+30 days'))`)
        .bind(SECOND_REFERRAL_ID, ORGANIZATION_ID, INVITER_ID, SECOND_INVITEE_ID),
    ]);
    await applyProgressMigration(db);
    expect((await db.prepare('SELECT * FROM user_onboarding_progress').all()).results).toEqual([{
      user_id: INVITEE_ID, trial_completed_at: '2026-09-01 12:00:00',
      debut_completed_at: '2026-09-01 12:00:00', debut_fighter_id: null,
    }]);
    expect((await db.prepare('SELECT membership_confirmed_at FROM crew_referrals').all()).results)
      .toEqual([{ membership_confirmed_at: null }, { membership_confirmed_at: null }]);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
  });
});
