type TokenGetter = () => Promise<string | null>;

let tokenGetter: TokenGetter | null = null;
let authRevision = 0;

export interface ApiRequestContext {
  readonly authRevision: number;
  readonly tokenGetter: TokenGetter | null;
  readonly providerSessionId: string | null;
  readonly detached?: boolean;
  readonly apiBaseUrl?: string;
  readonly authorizationScheme?: 'Bearer' | 'Generation' | 'Room';
  readonly providerRequestScope?: string;
}

export interface DetachedApiRequestContextOptions {
  apiBaseUrl: string;
  authorizationToken: string;
  authorizationScheme?: 'Bearer' | 'Generation' | 'Room';
  providerSessionId?: string | null;
  providerRequestScope?: string;
}

export class ApiSessionChangedError extends Error {
  constructor() {
    super('Your account changed while this operation was running. Please retry.');
    this.name = 'ApiSessionChangedError';
  }
}

export function configureApiAuth(getToken: TokenGetter | null): void {
  tokenGetter = getToken;
  authRevision += 1;
}

export function captureApiRequestContext(): ApiRequestContext {
  return Object.freeze({
    authRevision,
    tokenGetter,
    providerSessionId: null,
  });
}

export function createDetachedApiRequestContext(
  options: DetachedApiRequestContextOptions,
): ApiRequestContext {
  const apiBaseUrl = options.apiBaseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(apiBaseUrl)) {
    throw new Error('Detached API contexts require an absolute HTTP(S) API base URL.');
  }
  if (!options.authorizationToken.trim()) {
    throw new Error('Detached API contexts require an authorization token.');
  }
  const providerRequestScope = options.providerRequestScope?.trim();
  if (providerRequestScope && !/^[a-zA-Z0-9:_-]{1,160}$/.test(providerRequestScope)) {
    throw new Error('Detached provider request scopes may contain only letters, numbers, colons, underscores, and hyphens.');
  }
  return Object.freeze({
    authRevision: -1,
    tokenGetter: async () => options.authorizationToken,
    providerSessionId: options.providerSessionId ?? null,
    detached: true,
    apiBaseUrl,
    authorizationScheme: options.authorizationScheme ?? 'Bearer',
    providerRequestScope,
  });
}

export function withProviderSession(
  context: ApiRequestContext,
  sessionId: string | null | undefined,
): ApiRequestContext {
  return Object.freeze({
    ...context,
    providerSessionId: sessionId ?? null,
  });
}

export function assertApiRequestContextCurrent(context: ApiRequestContext): void {
  if (context.detached) return;
  if (context.authRevision !== authRevision || context.tokenGetter !== tokenGetter) {
    throw new ApiSessionChangedError();
  }
}

export async function runWithProviderSession<T>(
  sessionId: string | null | undefined,
  action: (context: ApiRequestContext) => Promise<T>,
  baseContext: ApiRequestContext = captureApiRequestContext(),
): Promise<T> {
  assertApiRequestContextCurrent(baseContext);
  return action(withProviderSession(baseContext, sessionId));
}

function configuredApiBase(context?: ApiRequestContext): string {
  if (context?.apiBaseUrl) return context.apiBaseUrl;
  const metaEnv = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  return String(metaEnv?.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
}

export function apiUrl(path: string, context?: ApiRequestContext): string {
  const base = configuredApiBase(context);
  if (/^https?:\/\//i.test(path)) {
    // Public manifests contain canonical production asset URLs. During local
    // development a relative API base deliberately routes those assets through
    // Vite too, avoiding browser CORS differences between ports and tunnels.
    if (base.startsWith('/')) {
      try {
        const absolute = new URL(path);
        if (absolute.origin === 'https://api.insertplayer.ai') {
          return `${base}${absolute.pathname}${absolute.search}`;
        }
      } catch {
        return path;
      }
    }
    return path;
  }
  if (!base) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function browserBaseUrl(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.href;
}

function originOf(url: string, base?: string): string | null {
  try {
    return new URL(url, base).origin;
  } catch {
    return null;
  }
}

function shouldAttachAuth(targetUrl: string, context?: ApiRequestContext): boolean {
  const targetOrigin = originOf(targetUrl, browserBaseUrl());
  if (!targetOrigin) return false;

  const apiBase = configuredApiBase(context);
  const apiOrigin = apiBase
    ? originOf(apiBase, browserBaseUrl())
    : originOf('/', browserBaseUrl());
  return Boolean(apiOrigin && targetOrigin === apiOrigin);
}

export async function apiFetch(
  input: string,
  init: RequestInit = {},
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<Response> {
  assertApiRequestContextCurrent(context);
  const targetUrl = apiUrl(input, context);
  const headers = new Headers(init.headers);
  const attachesAuth = shouldAttachAuth(targetUrl, context);
  const token = attachesAuth ? await context.tokenGetter?.() : null;
  assertApiRequestContextCurrent(context);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `${context.authorizationScheme ?? 'Bearer'} ${token}`);
  }
  if (context.providerSessionId && attachesAuth && !headers.has('X-ASF-Provider-Session')) {
    headers.set('X-ASF-Provider-Session', context.providerSessionId);
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (
    context.providerRequestScope &&
    attachesAuth &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    !headers.has('X-Insert-Player-Provider-Request-Key')
  ) {
    headers.set('X-Insert-Player-Provider-Request-Key', context.providerRequestScope);
  }
  const response = await fetch(targetUrl, {
    ...init,
    headers,
  });
  assertApiRequestContextCurrent(context);
  return response;
}
