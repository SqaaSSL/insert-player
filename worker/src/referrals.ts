import { createClerkClient } from '@clerk/backend';
import type {
  OrganizationInvitationAcceptedWebhookEvent,
  OrganizationMembershipWebhookEvent,
  OrganizationWebhookEvent,
} from '@clerk/backend/webhooks';
import { generateId, hmacIdentifier, normalizePublicDisplayName, upsertClerkUserProfile } from './auth';
import { AURA_ANIMATION_NAMES } from './fighterAssetPacks';
import { readJsonBody } from './requestBody';
import type { AuthContext, Env } from './types';
import { canManageCrew } from './crewAuthorization';
import { deleteCrewStageForOrganization } from './crewStages';

const MAX_INVITES_PER_DAY = 5;
const MAX_REWARDS_PER_INVITER = 3;
const MAX_INVITATION_BODY_BYTES = 8 * 1024;
const INVITATION_TTL_DAYS = 30;
const ALLOWED_OAUTH_PROVIDERS = new Set([
  'google',
  'apple',
  'microsoft',
  'microsoft_azure_active_directory',
]);
const AURA_ANIMATION_SQL_LIST = AURA_ANIMATION_NAMES.map((name) => `'${name}'`).join(', ');

function completeRookieAuraPackSql(fighterAlias: string): string {
  return `(
    SELECT COUNT(DISTINCT sprite.animation_name)
    FROM sprites sprite
    WHERE sprite.fighter_id = ${fighterAlias}.id
      AND sprite.quality_tier = 'rookie'
      AND sprite.animation_name IN (${AURA_ANIMATION_SQL_LIST})
      AND length(sprite.blob_key) > 0
      AND length(sprite.content_hash) = 64
      AND sprite.content_hash NOT GLOB '*[^0-9A-Fa-f]*'
      AND typeof(sprite.frame_w) = 'integer' AND sprite.frame_w BETWEEN 1 AND 4096
      AND typeof(sprite.frame_h) = 'integer' AND sprite.frame_h BETWEEN 1 AND 4096
      AND typeof(sprite.frame_count) = 'integer' AND sprite.frame_count BETWEEN 1 AND 64
  ) = ${AURA_ANIMATION_NAMES.length}`;
}

interface ReferralRow {
  id: string;
  clerk_invitation_id: string | null;
  clerk_organization_id: string;
  inviter_user_id: string;
  invitee_user_id: string | null;
  status: 'pending' | 'accepted' | 'qualified' | 'rewarded' | 'capped' | 'revoked' | 'rejected' | 'expired';
  crew_name: string;
  inviter_display_name: string;
  expires_at: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function clerk(env: Env) {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is required');
  return createClerkClient({ secretKey });
}

function normalizeInviteEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /[\s\u0000-\u001f\u007f]/.test(email)) return null;
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return null;
  return email;
}

function frontendOrigin(env: Env): string {
  for (const value of (env.CORS_ORIGIN ?? '').split(',')) {
    try {
      const origin = new URL(value.trim());
      if (origin.protocol === 'https:') return origin.origin;
    } catch {
      // Ignore malformed configuration entries and keep looking for HTTPS.
    }
  }
  return 'https://insertplayer.ai';
}

export async function createCrewInvitation(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const organizationId = auth.activeOrganizationId ?? null;
  if (!organizationId) {
    return json({ error: 'Create or select a Crew before inviting a friend', code: 'active_organization_required' }, 409);
  }
  if (!canManageCrew(auth)) return json({ error: 'Only a Crew admin can invite new members' }, 403);
  if (!auth.user.clerk_user_id) return json({ error: 'Your account is not connected to Clerk' }, 409);

  const body = await readJsonBody<{ email?: unknown }>(request, MAX_INVITATION_BODY_BYTES);
  const email = normalizeInviteEmail(body.email);
  if (!email) return json({ error: 'Enter a valid email address' }, 400);

  const activeInvites = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM crew_referrals
    WHERE inviter_user_id = ?
      AND datetime(created_at) >= datetime('now', '-1 day')
      AND status IN ('pending', 'accepted')
  `).bind(auth.userId).first<{ count: number }>();
  if ((activeInvites?.count ?? 0) >= MAX_INVITES_PER_DAY) {
    return json({ error: 'You have reached today\'s Crew invitation limit', code: 'invite_limit_reached' }, 429);
  }

  const emailHmac = await hmacIdentifier(env, 'crew-referral-email-v1', email);
  const prior = await env.DB.prepare(`
    SELECT id, status FROM crew_referrals
    WHERE invited_email_hmac = ? AND status IN ('pending', 'accepted', 'qualified', 'rewarded', 'capped')
    ORDER BY created_at DESC LIMIT 1
  `).bind(emailHmac).first<{ id: string; status: string }>();
  if (prior) {
    return json({ error: 'That friend already has an active Insert Player invitation', code: 'invite_already_exists' }, 409);
  }

  const clerkClient = clerk(env);
  const existing = await clerkClient.users.getUserList({ emailAddress: [email], limit: 1 });
  if (existing.data.length > 0) {
    return json({
      error: 'Referral rewards are only available for friends who are new to Insert Player',
      code: 'account_already_exists',
    }, 409);
  }

  const organization = await clerkClient.organizations.getOrganization({ organizationId });
  const referralId = generateId();
  const provisionalExpiry = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000).toISOString();
  await env.DB.prepare(`
    INSERT INTO crew_referrals (
      id, clerk_organization_id, inviter_user_id, invited_email_hmac,
      crew_name, inviter_display_name, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    referralId,
    organizationId,
    auth.userId,
    emailHmac,
    normalizePublicDisplayName(organization.name, 'Crew'),
    normalizePublicDisplayName(auth.user.display_name, 'A friend'),
    provisionalExpiry,
  ).run();

  try {
    const invitation = await clerkClient.organizations.createOrganizationInvitation({
      organizationId,
      inviterUserId: auth.user.clerk_user_id,
      emailAddress: email,
      role: 'org:member',
      expiresInDays: INVITATION_TTL_DAYS,
      redirectUrl: `${frontendOrigin(env)}/join?referral=${encodeURIComponent(referralId)}`,
      privateMetadata: { insert_player_referral_id: referralId },
      publicMetadata: { insert_player_referral: true },
    });
    await env.DB.prepare(`
      UPDATE crew_referrals
      SET clerk_invitation_id = ?, expires_at = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).bind(invitation.id, new Date(invitation.expiresAt).toISOString(), referralId).run();
  } catch (error) {
    await env.DB.prepare(`
      UPDATE crew_referrals SET status = 'rejected', updated_at = datetime('now') WHERE id = ?
    `).bind(referralId).run();
    throw error;
  }

  return json({
    invitation: { id: referralId, status: 'pending', expiresAt: provisionalExpiry },
    reward: { kind: 'rookie', pending: true, cap: MAX_REWARDS_PER_INVITER },
  }, 201);
}

export async function getReferralLanding(env: Env, referralId: string): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(referralId)) return json({ error: 'Invitation not found' }, 404);
  const referral = await env.DB.prepare(`
    SELECT id, clerk_organization_id, crew_name, inviter_display_name, status, expires_at
    FROM crew_referrals WHERE id = ? LIMIT 1
  `).bind(referralId).first<Pick<
    ReferralRow,
    'id' | 'clerk_organization_id' | 'crew_name' | 'inviter_display_name' | 'status' | 'expires_at'
  >>();
  if (!referral || ['revoked', 'rejected', 'expired'].includes(referral.status)) {
    return json({ error: 'Invitation not found' }, 404);
  }
  if (new Date(referral.expires_at).getTime() <= Date.now() && referral.status === 'pending') {
    await env.DB.prepare(`UPDATE crew_referrals SET status = 'expired', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
      .bind(referralId).run();
    return json({ error: 'This invitation has expired' }, 410);
  }
  return json({
    invitation: {
      id: referral.id,
      organizationId: referral.clerk_organization_id,
      crewName: referral.crew_name,
      inviterName: referral.inviter_display_name,
      status: referral.status,
    },
  });
}

export async function referralRookiePasses(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM fighter_entitlements
    WHERE user_id = ? AND kind = 'referral_rookie' AND status = 'unused'
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
  `).bind(userId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function getOnboardingStatus(env: Env, auth: AuthContext): Promise<Response> {
  const fighter = await env.DB.prepare(`
    SELECT f.id, f.photo_hash, f.name, f.public_flag
    FROM fighters f
    WHERE f.owner_user_id = ?
      AND f.quality_tier = 'rookie'
      AND NOT EXISTS (SELECT 1 FROM arcade_fighters af WHERE af.fighter_id = f.id)
      AND ${completeRookieAuraPackSql('f')}
    ORDER BY f.updated_at DESC LIMIT 1
  `).bind(auth.userId).first<{ id: string; photo_hash: string; name: string; public_flag: number }>();
  const organizationId = auth.activeOrganizationId ?? null;
  const invites = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM crew_referrals
    WHERE inviter_user_id = ?
      AND clerk_organization_id = ?
      AND status NOT IN ('rejected', 'revoked', 'expired')
  `).bind(auth.userId, organizationId ?? '').first<{ count: number }>();
  const sharedWithActiveCrew = Boolean(fighter && organizationId && !fighter.public_flag && await env.DB.prepare(`
    SELECT 1 AS shared FROM fighter_group_grants
    WHERE fighter_id = ? AND clerk_organization_id = ?
    LIMIT 1
  `).bind(fighter.id, organizationId).first<{ shared: number }>());
  const passes = await referralRookiePasses(env, auth.userId);
  const hasCrew = Boolean(organizationId);
  const canInviteCrew = hasCrew && canManageCrew(auth);
  const invitesSent = invites?.count ?? 0;
  const crewStage = organizationId ? await env.DB.prepare(`
    SELECT id, label, kind, status, created_at
    FROM crew_stages
    WHERE clerk_organization_id = ?
    LIMIT 1
  `).bind(organizationId).first<{
    id: string;
    label: string;
    kind: 'photo' | 'photo-direct' | null;
    status: 'reserved' | 'ready';
    created_at: string;
  }>() : null;
  const crewStageReady = crewStage?.status === 'ready';
  return json({
    fighter: fighter ? { id: fighter.id, photoHash: fighter.photo_hash, name: fighter.name } : null,
    activeCrew: hasCrew ? {
      id: auth.activeOrganizationId,
      slug: auth.activeOrganizationSlug ?? null,
      role: auth.activeOrganizationRole ?? null,
    } : null,
    invitesSent,
    sharedWithActiveCrew,
    canInviteCrew,
    crewStage: crewStageReady ? {
      id: crewStage.id,
      label: crewStage.label,
      kind: crewStage.kind,
      createdAt: crewStage.created_at,
    } : null,
    crewStageState: crewStage?.status ?? (hasCrew ? 'available' : 'unavailable'),
    crewStageReady,
    referralRookiePasses: passes,
    recommendedStep: !fighter || !hasCrew || !sharedWithActiveCrew
      ? (!fighter ? 'create' : 'crew')
      : canInviteCrew && invitesSent < 1
        ? 'invite'
        : canInviteCrew && !crewStageReady
          ? 'stage'
        : 'complete',
    complete: Boolean(
      fighter
      && hasCrew
      && sharedWithActiveCrew
      && (!canInviteCrew || (crewStageReady && invitesSent > 0)),
    ),
  });
}

function normalizedOAuthProvider(provider: string): string {
  return provider.toLowerCase().replace(/^oauth_/, '');
}

export async function recordOnboardingDebut(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJsonBody<{ fighterId?: unknown }>(request, MAX_INVITATION_BODY_BYTES);
  const fighterId = typeof body.fighterId === 'string' && /^[a-f0-9]{32}$/.test(body.fighterId)
    ? body.fighterId
    : null;
  if (!fighterId) return json({ error: 'A valid fighterId is required' }, 400);
  const fighter = await env.DB.prepare(`
    SELECT f.id FROM fighters f
    WHERE f.id = ? AND f.owner_user_id = ? AND f.quality_tier = 'rookie'
      AND ${completeRookieAuraPackSql('f')}
    LIMIT 1
  `).bind(fighterId, auth.userId).first<{ id: string }>();
  if (!fighter) return json({ error: 'The debut fighter is not an available Rookie' }, 403);

  const referral = await env.DB.prepare(`
    SELECT * FROM crew_referrals
    WHERE invitee_user_id = ? AND status IN ('accepted', 'qualified', 'rewarded', 'capped')
    ORDER BY accepted_at ASC LIMIT 1
  `).bind(auth.userId).first<ReferralRow>();
  if (!referral) return json({ recorded: true, referralQualified: false });
  if (auth.activeOrganizationId !== referral.clerk_organization_id) {
    return json({ recorded: true, referralQualified: false, reason: 'crew_not_active' });
  }
  if (referral.status === 'rewarded' || referral.status === 'capped') {
    return json({ recorded: true, referralQualified: true, rewardGranted: referral.status === 'rewarded' });
  }

  const clerkUserId = auth.user.clerk_user_id;
  if (!clerkUserId) return json({ error: 'A verified social account is required' }, 403);
  const clerkUser = await clerk(env).users.getUser(clerkUserId);
  const stableAccount = clerkUser.externalAccounts.find((account) => (
    ALLOWED_OAUTH_PROVIDERS.has(normalizedOAuthProvider(account.provider))
    && account.verification?.status === 'verified'
    && Boolean(account.providerUserId)
  ));
  if (!stableAccount) {
    return json({
      error: 'Sign in with a verified Google, Apple, or Microsoft account to qualify this referral',
      code: 'verified_oauth_required',
    }, 403);
  }
  const oauthIdentityHmac = await hmacIdentifier(
    env,
    'crew-referral-oauth-v1',
    `${normalizedOAuthProvider(stableAccount.provider)}:${stableAccount.providerUserId}`,
  );
  const usedIdentity = await env.DB.prepare(`
    SELECT id FROM crew_referrals
    WHERE oauth_identity_hmac = ? AND id <> ? AND status IN ('qualified', 'rewarded', 'capped')
    LIMIT 1
  `).bind(oauthIdentityHmac, referral.id).first<{ id: string }>();
  if (usedIdentity) return json({ error: 'This social account has already qualified a referral' }, 409);

  const entitlementId = generateId();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE crew_referrals
      SET status = 'qualified', oauth_identity_hmac = ?, qualified_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND invitee_user_id = ? AND status = 'accepted'
    `).bind(oauthIdentityHmac, referral.id, auth.userId),
    env.DB.prepare(`
      INSERT INTO fighter_entitlements (id, user_id, kind, source_referral_id)
      SELECT ?, inviter_user_id, 'referral_rookie', id
      FROM crew_referrals qualified
      WHERE qualified.id = ? AND qualified.status = 'qualified'
        AND NOT EXISTS (
          SELECT 1 FROM fighter_entitlements existing
          WHERE existing.source_referral_id = qualified.id
        )
        AND (
          SELECT COUNT(*) FROM fighter_entitlements earned
          WHERE earned.user_id = qualified.inviter_user_id
            AND earned.kind = 'referral_rookie'
        ) < ?
    `).bind(entitlementId, referral.id, MAX_REWARDS_PER_INVITER),
    env.DB.prepare(`
      UPDATE crew_referrals
      SET status = CASE
        WHEN EXISTS (SELECT 1 FROM fighter_entitlements reward WHERE reward.source_referral_id = crew_referrals.id)
          THEN 'rewarded'
        ELSE 'capped'
      END,
      rewarded_at = CASE
        WHEN EXISTS (SELECT 1 FROM fighter_entitlements reward WHERE reward.source_referral_id = crew_referrals.id)
          THEN datetime('now')
        ELSE rewarded_at
      END,
      updated_at = datetime('now')
      WHERE id = ? AND status = 'qualified'
    `).bind(referral.id),
  ]);
  const completed = await env.DB.prepare(`SELECT status FROM crew_referrals WHERE id = ?`)
    .bind(referral.id).first<{ status: ReferralRow['status'] }>();
  return json({
    recorded: true,
    referralQualified: true,
    rewardGranted: completed?.status === 'rewarded',
  });
}

export async function acceptReferralWebhook(
  event: OrganizationInvitationAcceptedWebhookEvent,
  env: Env,
): Promise<boolean> {
  const referralId = event.data.private_metadata?.insert_player_referral_id;
  if (typeof referralId !== 'string' || !/^[a-f0-9]{32}$/.test(referralId)) return false;
  const referral = await env.DB.prepare(`
    SELECT id, clerk_invitation_id, clerk_organization_id, status
    FROM crew_referrals WHERE id = ? LIMIT 1
  `).bind(referralId).first<Pick<ReferralRow, 'id' | 'clerk_invitation_id' | 'clerk_organization_id' | 'status'>>();
  if (!referral || referral.clerk_invitation_id !== event.data.id
    || referral.clerk_organization_id !== event.data.organization_id) return false;

  const clerkUser = await clerk(env).users.getUser(event.data.user_id);
  const primaryEmail = clerkUser.emailAddresses.find((address) => address.id === clerkUser.primaryEmailAddressId)
    ?? clerkUser.emailAddresses[0];
  const user = await upsertClerkUserProfile(env, clerkUser.id, {
    displayName: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || clerkUser.username,
    avatarUrl: clerkUser.imageUrl,
    email: primaryEmail?.emailAddress,
  }, { preserveMissingFields: true });
  await env.DB.prepare(`
    UPDATE crew_referrals
    SET invitee_user_id = ?, status = 'accepted', accepted_at = COALESCE(accepted_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).bind(user.id, referralId).run();
  return true;
}

export async function revokeCrewWebhook(
  event: OrganizationMembershipWebhookEvent | OrganizationWebhookEvent,
  env: Env,
): Promise<boolean> {
  if (event.type === 'organization.deleted') {
    const organizationId = event.data.id;
    if (!organizationId) return false;
    await deleteCrewStageForOrganization(env, organizationId);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM fighter_group_grants WHERE clerk_organization_id = ?').bind(organizationId),
      env.DB.prepare(`
        UPDATE crew_referrals SET status = 'revoked', updated_at = datetime('now')
        WHERE clerk_organization_id = ? AND status IN ('pending', 'accepted')
      `).bind(organizationId),
    ]);
    return true;
  }
  if (event.type !== 'organizationMembership.deleted') return false;
  const organizationId = event.data.organization.id;
  const clerkUserId = event.data.public_user_data.user_id;
  const user = await env.DB.prepare('SELECT id FROM users WHERE clerk_user_id = ?')
    .bind(clerkUserId).first<{ id: string }>();
  if (!organizationId || !user) return false;
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM fighter_group_grants
      WHERE clerk_organization_id = ? AND granted_by_user_id = ?
    `).bind(organizationId, user.id),
    env.DB.prepare(`
      UPDATE crew_referrals SET status = 'revoked', updated_at = datetime('now')
      WHERE clerk_organization_id = ? AND invitee_user_id = ? AND status = 'accepted'
    `).bind(organizationId, user.id),
  ]);
  return true;
}
