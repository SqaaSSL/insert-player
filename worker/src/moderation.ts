import type { AuthContext, Env } from './types';
import { readJsonBody } from './requestBody';

const MAX_MODERATION_BODY_BYTES = 2 * 1024;
const MAX_MODERATION_NOTE_CHARS = 500;
const MODERATION_STATUSES = new Set(['open', 'reviewing', 'dismissed', 'actioned']);
const REVIEW_ACTION_STATUSES = new Set(['reviewing', 'dismissed', 'actioned']);
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

interface CommunityReportRow {
  id: string;
  fighter_id: string;
  fighter_name: string;
  reporter_user_id: string | null;
  reason: string;
  details: string | null;
  status: string;
  submission_count: number;
  reviewed_by_user_id: string | null;
  moderation_note: string | null;
  created_at: string;
  updated_at: string;
  current_fighter_name: string | null;
  fighter_public_flag: number | null;
  owner_name: string | null;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE_HEADERS });
}

function requireModerator(auth: AuthContext): Response | null {
  if (auth.user.plan_tier === 'admin') return null;
  return json({ error: 'Moderator access required' }, 403);
}

function normalizeModerationNote(value: unknown): string | null | Response {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return json({ error: 'Moderation note must be text' }, 400);
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!normalized) return null;
  if (normalized.length > MAX_MODERATION_NOTE_CHARS) {
    return json({ error: `Moderation note must be ${MAX_MODERATION_NOTE_CHARS} characters or fewer` }, 400);
  }
  return normalized;
}

function serializeCommunityReport(row: CommunityReportRow) {
  return {
    id: row.id,
    fighterId: row.fighter_id,
    fighterName: row.current_fighter_name ?? row.fighter_name,
    fighterExists: row.current_fighter_name !== null,
    fighterPublic: row.fighter_public_flag === 1,
    ownerName: row.owner_name ?? 'Deleted player',
    reason: row.reason,
    details: row.details,
    status: row.status,
    submissionCount: row.submission_count,
    reporterAvailable: row.reporter_user_id !== null,
    reviewedByUserId: row.reviewed_by_user_id,
    moderationNote: row.moderation_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getCommunityReport(env: Env, reportId: string): Promise<CommunityReportRow | null> {
  return env.DB.prepare(`
    SELECT
      cr.*,
      f.name AS current_fighter_name,
      f.public_flag AS fighter_public_flag,
      owner.display_name AS owner_name
    FROM community_reports cr
    LEFT JOIN fighters f ON f.id = cr.fighter_id
    LEFT JOIN users owner ON owner.id = cr.fighter_owner_user_id
    WHERE cr.id = ?
    LIMIT 1
  `).bind(reportId).first<CommunityReportRow>();
}

export async function listCommunityReports(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const forbidden = requireModerator(auth);
  if (forbidden) return forbidden;

  const url = new URL(request.url);
  const status = url.searchParams.get('status')?.trim() || 'open';
  if (!MODERATION_STATUSES.has(status)) {
    return json({ error: 'Invalid moderation status' }, 400);
  }
  const parsedLimit = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, Math.round(parsedLimit))) : 50;
  const { results } = await env.DB.prepare(`
    SELECT
      cr.*,
      f.name AS current_fighter_name,
      f.public_flag AS fighter_public_flag,
      owner.display_name AS owner_name
    FROM community_reports cr
    LEFT JOIN fighters f ON f.id = cr.fighter_id
    LEFT JOIN users owner ON owner.id = cr.fighter_owner_user_id
    WHERE cr.status = ?
    ORDER BY cr.updated_at ASC, cr.id ASC
    LIMIT ?
  `).bind(status, limit).all<CommunityReportRow>();

  return json({
    reports: (results ?? []).map(serializeCommunityReport),
    status,
    limit,
  });
}

export async function moderateCommunityReport(
  request: Request,
  env: Env,
  auth: AuthContext,
  reportId: string,
): Promise<Response> {
  const forbidden = requireModerator(auth);
  if (forbidden) return forbidden;

  const body = await readJsonBody<{
    status?: unknown;
    moderationNote?: unknown;
    unpublishFighter?: unknown;
  }>(request, MAX_MODERATION_BODY_BYTES);
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!REVIEW_ACTION_STATUSES.has(status)) {
    return json({ error: 'Select a valid moderation action' }, 400);
  }
  if (body.unpublishFighter !== undefined && typeof body.unpublishFighter !== 'boolean') {
    return json({ error: 'unpublishFighter must be a boolean' }, 400);
  }
  const unpublishFighter = body.unpublishFighter === true;
  if (unpublishFighter && status !== 'actioned') {
    return json({ error: 'A fighter can only be unpublished with an actioned report' }, 400);
  }

  const moderationNote = normalizeModerationNote(body.moderationNote);
  if (moderationNote instanceof Response) return moderationNote;
  if ((status === 'dismissed' || status === 'actioned') && !moderationNote) {
    return json({ error: 'Add a moderation note before closing a report' }, 400);
  }

  const existing = await getCommunityReport(env, reportId);
  if (!existing) return json({ error: 'Community report not found' }, 404);

  const statements = [
    env.DB.prepare(`
      UPDATE community_reports
      SET
        status = ?,
        reviewed_by_user_id = ?,
        moderation_note = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(status, auth.userId, moderationNote, reportId),
  ];
  if (unpublishFighter) {
    statements.push(env.DB.prepare(`
      UPDATE fighters
      SET public_flag = 0, updated_at = datetime('now')
      WHERE id = ?
    `).bind(existing.fighter_id));
  }
  await env.DB.batch(statements);

  const updated = await getCommunityReport(env, reportId);
  if (!updated) throw new Error('Moderated community report disappeared');
  return json({ report: serializeCommunityReport(updated) });
}
