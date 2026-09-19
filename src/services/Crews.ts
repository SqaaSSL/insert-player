import { apiFetch, assertApiRequestContextCurrent, captureApiRequestContext, withApiRequestTimeout, type ApiRequestContext } from './ApiClient.ts';
import { listCloudFighters, setCloudFighterAccess, type CloudFighter } from './CloudFighters.ts';

export interface OnboardingFighter {
  id: string;
  photoHash: string;
  name: string;
}

export interface OnboardingStatus {
  trialComplete: boolean;
  debutComplete: boolean;
  crewMembershipVerificationUnavailable?: boolean;
  fighter: OnboardingFighter | null;
  activeCrew: {
    id: string;
    slug: string | null;
    role: string | null;
  } | null;
  invitesSent: number;
  invitesAccepted: number;
  pendingInvite: CrewInviteLink | null;
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
  recommendedStep: 'create' | 'debut' | 'crew' | 'stage' | 'invite' | 'complete';
  complete: boolean;
}

export interface ReferralLanding {
  id: string;
  organizationId: string;
  crewName: string;
  inviterName: string;
  inviteChannel?: 'email' | 'link';
  status: 'pending' | 'accepted' | 'qualified' | 'rewarded' | 'capped';
}

export interface CrewInviteLink {
  id: string;
  status: 'pending';
  expiresAt: string;
  url: string;
}

async function apiError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => ({})) as { error?: unknown };
  return new Error(typeof body.error === 'string' && body.error.trim() ? body.error : fallback);
}

async function scopedJson<T>(res: Response, context: ApiRequestContext, signal: AbortSignal): Promise<T> {
  const body = await res.json() as T;
  signal.throwIfAborted();
  assertApiRequestContextCurrent(context);
  return body;
}

export async function loadOnboardingStatus(
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<OnboardingStatus> {
  return withApiRequestTimeout(async (signal) => {
    const res = await apiFetch('/api/onboarding', { signal }, context);
    if (!res.ok) throw await apiError(res, `Onboarding status failed (${res.status})`);
    return scopedJson<OnboardingStatus>(res, context, signal);
  });
}

export async function loadReferralLanding(
  referralId: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<ReferralLanding> {
  return withApiRequestTimeout(async (signal) => {
    const res = await apiFetch(`/api/referrals/${encodeURIComponent(referralId)}`, { signal }, context);
    if (!res.ok) throw await apiError(res, res.status === 410 ? 'This invitation has expired.' : 'Invitation not found.');
    const body = await scopedJson<{ invitation: ReferralLanding }>(res, context, signal);
    return body.invitation;
  });
}

export async function createCrewInviteLink(
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CrewInviteLink> {
  return withApiRequestTimeout(async (signal) => {
    const res = await apiFetch('/api/crew/invite-links', { method: 'POST', signal }, context);
    if (!res.ok) throw await apiError(res, `Crew invite link failed (${res.status})`);
    const body = await scopedJson<{ invitation: CrewInviteLink }>(res, context, signal);
    return body.invitation;
  });
}

export async function acceptCrewInviteLink(
  referralId: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<void> {
  await withApiRequestTimeout(async (signal) => {
    const res = await apiFetch(`/api/referrals/${encodeURIComponent(referralId)}/accept`, {
      method: 'POST', signal,
    }, context);
    if (!res.ok) throw await apiError(res, `Crew invitation could not be accepted (${res.status})`);
    signal.throwIfAborted();
    assertApiRequestContextCurrent(context);
  });
}

export async function recordOnboardingDebut(
  fighterId: string,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<void> {
  await withApiRequestTimeout(async (signal) => {
    const res = await apiFetch('/api/onboarding/debut', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fighterId }),
    }, context);
    if (!res.ok) throw await apiError(res, `Debut could not be recorded (${res.status})`);
    signal.throwIfAborted();
    assertApiRequestContextCurrent(context);
  });
}

const TRIAL_COMPLETED_KEY = 'asf:onboarding:trial-completed';
const PENDING_DEBUT_PREFIX = 'asf:onboarding:pending-debut:';
const PROGRESS_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const progressSyncs = new Map<string, Promise<void>>();

export function rememberCompletedAuraTrial(): void {
  try { localStorage.setItem(TRIAL_COMPLETED_KEY, String(Date.now())); } catch { /* optional recovery */ }
}

function pendingDebutKey(account: string): string {
  return `${PENDING_DEBUT_PREFIX}${encodeURIComponent(account)}`;
}

/** Save before sending so a tab close/offline result cannot lose the reward. */
export async function recordDebutWithRecovery(fighterId: string, account: string): Promise<void> {
  const context = captureApiRequestContext();
  const key = pendingDebutKey(account);
  const at = Date.now();
  try { localStorage.setItem(key, JSON.stringify({ fighterId, at })); } catch { /* still send */ }
  await recordOnboardingDebut(fighterId, context);
  assertApiRequestContextCurrent(context);
  try {
    const pending = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (pending?.fighterId === fighterId && pending?.at === at) localStorage.removeItem(key);
  } catch { /* optional recovery */ }
}

export function syncOnboardingProgress(account: string): Promise<void> {
  const context = captureApiRequestContext();
  const key = `${context.authRevision}:${account}`;
  const current = progressSyncs.get(key);
  if (current) return current;
  const sync = syncStoredOnboardingProgress(account, context);
  progressSyncs.set(key, sync);
  void sync.finally(() => {
    if (progressSyncs.get(key) === sync) progressSyncs.delete(key);
  }).catch(() => { /* The original caller receives the failure. */ });
  return sync;
}

async function syncStoredOnboardingProgress(account: string, context: ApiRequestContext): Promise<void> {
  let trial = 0;
  let pending: { fighterId: string; at: number } | null = null;
  try {
    trial = Number(localStorage.getItem(TRIAL_COMPLETED_KEY));
    pending = JSON.parse(localStorage.getItem(pendingDebutKey(account)) ?? 'null');
  } catch { /* storage can be unavailable */ }
  const operations: Promise<void>[] = [];
  if (trial > 0 && trial <= Date.now() && Date.now() - trial < PROGRESS_MAX_AGE) operations.push(withApiRequestTimeout(async (signal) => {
    const response = await apiFetch('/api/onboarding/trial', { method: 'POST', signal }, context);
    if (!response.ok) throw await apiError(response, 'Your trial progress could not be saved.');
    signal.throwIfAborted();
    assertApiRequestContextCurrent(context);
    try {
      if (Number(localStorage.getItem(TRIAL_COMPLETED_KEY)) === trial) localStorage.removeItem(TRIAL_COMPLETED_KEY);
    } catch { /* optional recovery */ }
  }));
  if (pending && /^[a-f0-9]{32}$/.test(pending.fighterId) && Number.isFinite(pending.at)
    && pending.at > 0 && pending.at <= Date.now()) {
    const saved = pending;
    operations.push((async () => {
      await recordOnboardingDebut(saved.fighterId, context);
      assertApiRequestContextCurrent(context);
      try {
        const current = JSON.parse(localStorage.getItem(pendingDebutKey(account)) ?? 'null');
        if (current?.fighterId === saved.fighterId && current?.at === saved.at) localStorage.removeItem(pendingDebutKey(account));
      } catch { /* optional recovery */ }
    })());
  }
  const outcomes = await Promise.allSettled(operations);
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export async function shareFighterWithActiveCrew(
  fighter: { id?: string | null; photoHash?: string | null },
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<CloudFighter> {
  return withApiRequestTimeout(async (signal) => {
    let fighterId = fighter.id ?? null;
    if (!fighterId && fighter.photoHash) {
      const cloudFighters = await listCloudFighters(context, { signal });
      fighterId = cloudFighters.find((candidate) => candidate.photoHash === fighter.photoHash)?.id ?? null;
    }
    if (!fighterId) throw new Error('Your Rookie is still syncing. Try again in a moment.');
    signal.throwIfAborted();
    const shared = await setCloudFighterAccess(fighterId, 'crew', context, { signal });
    if (!shared) throw new Error('Sign in again to share this Rookie with your Crew.');
    signal.throwIfAborted();
    assertApiRequestContextCurrent(context);
    return shared;
  });
}
