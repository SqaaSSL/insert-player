import { apiFetch, type ApiRequestContext } from './ApiClient';

export type ModerationStatus = 'open' | 'reviewing' | 'dismissed' | 'actioned';

export interface CommunityModerationReport {
  id: string;
  fighterId: string;
  fighterName: string;
  fighterExists: boolean;
  fighterPublic: boolean;
  ownerName: string;
  reason: string;
  details: string | null;
  status: ModerationStatus;
  submissionCount: number;
  reporterAvailable: boolean;
  reviewedByUserId: string | null;
  moderationNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityModerationQueue {
  access: 'granted' | 'signed_out' | 'forbidden';
  reports: CommunityModerationReport[];
}

function isLocalDevWithoutApi(): boolean {
  return import.meta.env.DEV && !String(import.meta.env.VITE_API_BASE_URL ?? '').trim();
}

async function responseError(res: Response, fallback: string): Promise<string> {
  try {
    const json = await res.json() as { error?: unknown };
    if (typeof json.error === 'string' && json.error.trim()) return json.error.trim();
  } catch {
    // Use the status fallback for non-JSON responses.
  }
  return fallback;
}

export async function listCommunityModerationReports(
  status: ModerationStatus,
  context?: ApiRequestContext,
): Promise<CommunityModerationQueue> {
  if (isLocalDevWithoutApi()) return { access: 'forbidden', reports: [] };
  const res = await apiFetch(`/api/admin/community-reports?status=${encodeURIComponent(status)}&limit=100`, {}, context);
  if (res.status === 401 || res.status === 503) return { access: 'signed_out', reports: [] };
  if (res.status === 403) return { access: 'forbidden', reports: [] };
  if (!res.ok) throw new Error(await responseError(res, `Moderation queue failed (${res.status})`));
  const json = await res.json() as { reports?: CommunityModerationReport[] };
  return { access: 'granted', reports: json.reports ?? [] };
}

export async function updateCommunityModerationReport(
  reportId: string,
  status: Exclude<ModerationStatus, 'open'>,
  moderationNote: string,
  unpublishFighter: boolean,
  context?: ApiRequestContext,
): Promise<CommunityModerationReport> {
  const res = await apiFetch(`/api/admin/community-reports/${encodeURIComponent(reportId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, moderationNote: moderationNote.trim() || null, unpublishFighter }),
  }, context);
  if (!res.ok) throw new Error(await responseError(res, `Moderation update failed (${res.status})`));
  const json = await res.json() as { report?: CommunityModerationReport };
  if (!json.report) throw new Error('Moderation API returned no report');
  return json.report;
}
