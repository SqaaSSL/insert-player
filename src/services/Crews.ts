import { apiFetch, captureApiRequestContext, type ApiRequestContext } from './ApiClient.ts';
import { listCloudFighters, setCloudFighterAccess, type CloudFighter } from './CloudFighters.ts';

export interface OnboardingFighter {
  id: string;
  photoHash: string;
  name: string;
}

export interface OnboardingStatus {
  fighter: OnboardingFighter | null;
  activeCrew: {
    id: string;
    slug: string | null;
    role: string | null;
  } | null;
  invitesSent: number;
  sharedWithActiveCrew: boolean;
  canInviteCrew: boolean;
  crewStage: {
    id: string;
    label: string;
    kind: 'photo' | 'photo-direct';
    createdAt: string;
  } | null;
  crewStageState: 'unavailable' | 'available' | 'reserved' | 'ready';
  crewStageReady: boolean;
  referralRookiePasses: number;
  recommendedStep: 'create' | 'crew' | 'stage' | 'invite' | 'complete';
  complete: boolean;
}

export interface ReferralLanding {
  id: string;
  organizationId: string;
  crewName: string;
  inviterName: string;
  status: 'pending' | 'accepted' | 'qualified' | 'rewarded' | 'capped';
}

export interface CrewInvitationResult {
  id: string;
  status: 'pending';
  expiresAt: string;
}

async function apiError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => ({})) as { error?: unknown };
  return new Error(typeof body.error === 'string' && body.error.trim() ? body.error : fallback);
}

export async function loadOnboardingStatus(
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<OnboardingStatus> {
  const res = await apiFetch('/api/onboarding', {}, context);
  if (!res.ok) throw await apiError(res, `Onboarding status failed (${res.status})`);
  return res.json() as Promise<OnboardingStatus>;
}

export async function loadReferralLanding(referralId: string): Promise<ReferralLanding> {
  const res = await apiFetch(`/api/referrals/${encodeURIComponent(referralId)}`);
  if (!res.ok) throw await apiError(res, res.status === 410 ? 'This invitation has expired.' : 'Invitation not found.');
  const body = await res.json() as { invitation: ReferralLanding };
  return body.invitation;
}

export async function sendCrewInvitation(
  email: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CrewInvitationResult> {
  const res = await apiFetch('/api/crew/invitations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }, context);
  if (!res.ok) throw await apiError(res, `Crew invitation failed (${res.status})`);
  const body = await res.json() as { invitation: CrewInvitationResult };
  return body.invitation;
}

export async function recordOnboardingDebut(
  fighterId: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<void> {
  const res = await apiFetch('/api/onboarding/debut', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fighterId }),
  }, context);
  if (!res.ok) throw await apiError(res, `Debut could not be recorded (${res.status})`);
}

export async function shareFighterWithActiveCrew(
  fighter: { id?: string | null; photoHash?: string | null },
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CloudFighter> {
  let fighterId = fighter.id ?? null;
  if (!fighterId && fighter.photoHash) {
    const cloudFighters = await listCloudFighters(context);
    fighterId = cloudFighters.find((candidate) => candidate.photoHash === fighter.photoHash)?.id ?? null;
  }
  if (!fighterId) throw new Error('Your Rookie is still syncing. Try again in a moment.');
  const shared = await setCloudFighterAccess(fighterId, 'crew', context);
  if (!shared) throw new Error('Sign in again to share this Rookie with your Crew.');
  return shared;
}
