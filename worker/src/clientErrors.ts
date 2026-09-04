import type { Env, PublicAuthContext } from './types';
import { readJsonBody } from './requestBody';

const MAX_CLIENT_ERROR_BODY_BYTES = 32 * 1024;
const MAX_MESSAGE_CHARS = 600;
const MAX_STACK_CHARS = 4000;
const MAX_DEBUG_TAIL_CHARS = 4000;
const MAX_ROUTE_CHARS = 120;
const MAX_APP_CONTEXT_CHARS = 400;
const MAX_USER_AGENT_CHARS = 300;

export interface ClientErrorReport {
  route: string;
  message: string;
  stack: string | null;
  debugTail: string | null;
  appContext: string | null;
  userAgent: string | null;
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxChars);
}

/**
 * Normalizes an incoming crash report to bounded, storage-safe fields.
 * Returns null when the payload carries no usable error message.
 */
export function sanitizeClientErrorReport(body: Record<string, unknown>): ClientErrorReport | null {
  const message = boundedText(body.message, MAX_MESSAGE_CHARS);
  if (!message) return null;
  const route = boundedText(body.route, MAX_ROUTE_CHARS) ?? 'unknown';
  return {
    route: route.startsWith('/') ? route : 'unknown',
    message,
    stack: boundedText(body.stack, MAX_STACK_CHARS),
    debugTail: boundedText(body.debugTail, MAX_DEBUG_TAIL_CHARS),
    appContext: boundedText(body.appContext, MAX_APP_CONTEXT_CHARS),
    userAgent: boundedText(body.userAgent, MAX_USER_AGENT_CHARS),
  };
}

export async function submitClientError(
  request: Request,
  env: Env,
  auth: PublicAuthContext,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, MAX_CLIENT_ERROR_BODY_BYTES);
  } catch {
    return Response.json({ error: 'Invalid crash report body' }, { status: 400 });
  }

  const report = sanitizeClientErrorReport(body);
  if (!report) {
    return Response.json({ error: 'Crash report requires a message' }, { status: 400 });
  }

  await env.DB.prepare(`
    INSERT INTO client_errors (id, clerk_user_id, route, message, stack, debug_tail, app_context, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    auth.userId ?? null,
    report.route,
    report.message,
    report.stack,
    report.debugTail,
    report.appContext,
    report.userAgent,
  ).run();

  return Response.json({ received: true }, { status: 202 });
}
