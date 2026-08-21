export type AuthStatus = 'local' | 'loading' | 'signed-out' | 'signed-in';

export interface AuthRouteState {
  authStatus: AuthStatus;
  authSessionKey: string;
}

function isLocalDevWithoutApi(): boolean {
  return import.meta.env.DEV && !String(import.meta.env.VITE_API_BASE_URL ?? '').trim();
}

export function paidTiersLocked(authStatus: AuthStatus): boolean {
  return authStatus !== 'signed-in' && !isLocalDevWithoutApi();
}
