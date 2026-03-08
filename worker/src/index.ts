import type { Env, User } from './types';
import {
  exchangeGoogleCode,
  findOrCreateUser,
  createSession,
  validateSession,
  deleteSession,
  getSessionIdFromRequest,
  sessionCookie,
} from './auth';
import { uploadPhoto, getCharacter, listCharacters, getSpriteAsset } from './sprites';
import { getLeaderboard, getPlayerStats, reportMatchResult } from './leaderboard';
import { generateId } from './auth';

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function requireAuth(request: Request, env: Env): Promise<User | Response> {
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) {
    return json({ error: 'Unauthorized' }, 401, corsHeaders(env));
  }
  const user = await validateSession(env, sessionId);
  if (!user) {
    return json({ error: 'Session expired' }, 401, corsHeaders(env));
  }
  return user;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const addCors = (response: Response): Response => {
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(env))) {
        headers.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers });
    };

    try {
      // --- Auth Routes ---

      if (path === '/auth/google' && method === 'GET') {
        const redirectUri = `${url.origin}/auth/google/callback`;
        const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        googleAuthUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
        googleAuthUrl.searchParams.set('redirect_uri', redirectUri);
        googleAuthUrl.searchParams.set('response_type', 'code');
        googleAuthUrl.searchParams.set('scope', 'openid profile email');
        googleAuthUrl.searchParams.set('access_type', 'offline');

        return Response.redirect(googleAuthUrl.toString(), 302);
      }

      if (path === '/auth/google/callback' && method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) {
          return addCors(json({ error: 'Missing auth code' }, 400));
        }

        const redirectUri = `${url.origin}/auth/google/callback`;
        const googleUser = await exchangeGoogleCode(code, redirectUri, env);

        const user = await findOrCreateUser(
          env,
          'google',
          googleUser.sub,
          googleUser.name,
          googleUser.picture
        );

        const sessionId = await createSession(env, user.id);
        const gameUrl = env.CORS_ORIGIN || url.origin;

        return new Response(null, {
          status: 302,
          headers: {
            Location: `${gameUrl}/?authenticated=true`,
            'Set-Cookie': sessionCookie(sessionId),
          },
        });
      }

      if (path === '/auth/me' && method === 'GET') {
        const result = await requireAuth(request, env);
        if (result instanceof Response) return addCors(result);
        const user = result;
        return addCors(json({
          user: {
            id: user.id,
            displayName: user.display_name,
            avatarUrl: user.avatar_url,
            eloRating: user.elo_rating,
            wins: user.wins,
            losses: user.losses,
            winStreak: user.win_streak,
          },
        }));
      }

      if (path === '/auth/logout' && method === 'POST') {
        const sessionId = getSessionIdFromRequest(request);
        if (sessionId) {
          await deleteSession(env, sessionId);
        }
        return addCors(new Response(null, {
          status: 200,
          headers: { 'Set-Cookie': sessionCookie('', 0) },
        }));
      }

      // --- Character/Sprite Routes ---

      if (path === '/api/characters' && method === 'POST') {
        const result = await requireAuth(request, env);
        if (result instanceof Response) return addCors(result);
        return addCors(await uploadPhoto(request, env, result.id));
      }

      if (path === '/api/characters' && method === 'GET') {
        const result = await requireAuth(request, env);
        if (result instanceof Response) return addCors(result);
        return addCors(await listCharacters(env, result.id));
      }

      if (path.startsWith('/api/characters/') && method === 'GET') {
        const charId = path.split('/')[3];
        const result = await requireAuth(request, env);
        if (result instanceof Response) return addCors(result);
        return addCors(await getCharacter(env, charId, result.id));
      }

      if (path.startsWith('/sprites/') && method === 'GET') {
        const key = path.slice('/sprites/'.length);
        return addCors(await getSpriteAsset(env, key));
      }

      // --- Leaderboard Routes ---

      if (path === '/api/leaderboard' && method === 'GET') {
        return addCors(await getLeaderboard(env));
      }

      if (path === '/api/stats' && method === 'GET') {
        const result = await requireAuth(request, env);
        if (result instanceof Response) return addCors(result);
        return addCors(await getPlayerStats(env, result.id));
      }

      if (path.startsWith('/api/stats/') && method === 'GET') {
        const userId = path.split('/')[3];
        return addCors(await getPlayerStats(env, userId));
      }

      // --- Match Result Reporting ---

      if (path === '/api/matches' && method === 'POST') {
        const result = await requireAuth(request, env);
        if (result instanceof Response) return addCors(result);
        const body = await request.json() as any;
        return addCors(await reportMatchResult(env, {
          matchId: generateId(),
          player1Id: body.player1Id,
          player2Id: body.player2Id,
          winnerId: body.winnerId,
          roundsP1: body.roundsP1,
          roundsP2: body.roundsP2,
          duration: body.duration,
          p1CharId: body.p1CharacterId,
          p2CharId: body.p2CharacterId,
          isRanked: body.isRanked ?? false,
        }));
      }

      // --- Health Check ---

      if (path === '/health') {
        return addCors(json({ status: 'ok', version: '0.1.0' }));
      }

      return addCors(json({ error: 'Not found' }, 404));

    } catch (err: any) {
      console.error('Worker error:', err);
      return addCors(json({ error: 'Internal server error', message: err.message }, 500));
    }
  },
};
