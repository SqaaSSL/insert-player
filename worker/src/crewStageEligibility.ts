import { createClerkClient } from '@clerk/backend';
import type { Env } from './types';

const VERIFIED_PROVIDERS = new Set(['google', 'apple', 'microsoft', 'microsoft_azure_active_directory']);
const MAX_VERIFIED_CANDIDATES = 12;
const VERIFICATION_TIMEOUT_MS = 4_000;

async function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Crew verification timed out')), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface CrewStageEligibility {
  eligible: boolean;
  /** Zero or one verified witness, not a total Crew membership count. */
  acceptedMemberCount: number;
  unavailable: boolean;
}

/**
 * Invitation acceptance is not membership: a Clerk join can fail after the link
 * is claimed, and a member can later leave. New included-stage claims therefore
 * require a current member with a verified social account, not just a D1 status.
 * The benefit belongs to the Crew, regardless of which admin sent the invite.
 */
export async function getCrewStageEligibility(
  env: Env,
  organizationId: string,
): Promise<CrewStageEligibility> {
  const referrals = await env.DB.prepare(`
    SELECT invitee.clerk_user_id
    FROM crew_referrals referral
    JOIN users invitee ON invitee.id = referral.invitee_user_id
    JOIN users inviter ON inviter.id = referral.inviter_user_id
    WHERE referral.clerk_organization_id = ?
      AND referral.status IN ('accepted', 'qualified', 'rewarded', 'capped')
      AND referral.invitee_user_id <> referral.inviter_user_id
      AND invitee.clerk_user_id IS NOT NULL
      AND invitee.clerk_user_id <> inviter.clerk_user_id
    GROUP BY invitee.clerk_user_id
    ORDER BY MAX(referral.rowid) DESC
    LIMIT ?
  `).bind(organizationId, MAX_VERIFIED_CANDIDATES + 1).all<{ clerk_user_id: string }>();
  if (referrals.results.length === 0) {
    return { eligible: false, acceptedMemberCount: 0, unavailable: false };
  }
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!secretKey) return { eligible: false, acceptedMemberCount: 0, unavailable: true };
  const clerk = createClerkClient({ secretKey });
  // Bound Clerk work on routes that refresh at focus. If the bound prevents
  // proving eligibility, report an unavailable check rather than "no friend".
  let unavailable = referrals.results.length > MAX_VERIFIED_CANDIDATES;
  const deadline = Date.now() + VERIFICATION_TIMEOUT_MS;
  for (const candidate of referrals.results.slice(0, MAX_VERIFIED_CANDIDATES)) {
    if (Date.now() >= deadline) return { eligible: false, acceptedMemberCount: 0, unavailable: true };
    try {
      const membership = await withinDeadline(clerk.organizations.getOrganizationMembershipList({
        organizationId,
        userId: [candidate.clerk_user_id],
        limit: 1,
      }), deadline);
      if (membership.data.length === 0) continue;
      if (Date.now() >= deadline) return { eligible: false, acceptedMemberCount: 0, unavailable: true };
      const user = await withinDeadline(clerk.users.getUser(candidate.clerk_user_id), deadline);
      if (user.externalAccounts.some((account) => (
        VERIFIED_PROVIDERS.has(account.provider.toLowerCase().replace(/^oauth_/, ''))
        && account.verification?.status === 'verified'
        && Boolean(account.providerUserId)
      ))) {
        // One verified accepted friend is sufficient. Avoid fetching the rest
        // of the Crew just to authorize its single stage.
        return { eligible: true, acceptedMemberCount: 1, unavailable: false };
      }
    } catch (error) {
      // A deleted user/organization cannot establish eligibility. A transient
      // Clerk error must fail closed and remain distinguishable from no friend.
      if ((error as { status?: number })?.status !== 404) unavailable = true;
    }
  }
  return { eligible: false, acceptedMemberCount: 0, unavailable };
}

export function crewStageEligibilityError(eligibility: CrewStageEligibility): Response | null {
  if (eligibility.eligible) return null;
  return Response.json({
    authorized: false,
    error: eligibility.unavailable
      ? 'We could not verify your Crew right now. Try again in a moment.'
      : 'Your included Crew stage unlocks after a friend joins with a verified Google, Apple, or Microsoft account.',
    code: eligibility.unavailable ? 'crew_stage_verification_unavailable' : 'crew_stage_friend_required',
  }, {
    status: eligibility.unavailable ? 503 : 409,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
