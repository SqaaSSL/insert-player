const VERSUS_ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const VERSUS_ROOM_CODE_PATTERN = new RegExp(`^[${VERSUS_ROOM_CODE_ALPHABET}]{6}$`);
const VERSUS_INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const PENDING_VERSUS_INVITE_STORAGE_KEY = 'insert-player.pending-versus-invite.v3';
const VERSUS_GUEST_ID_STORAGE_KEY_PREFIX = 'insert-player.versus-guest.v1.';
const LEGACY_PENDING_VERSUS_INVITE_STORAGE_KEYS = [
  'insert-player.pending-versus-invite.v2',
  'insert-player.pending-versus-invite.v1',
];

export const PENDING_VERSUS_INVITE_TTL_MS = 30 * 60 * 1000;

interface InviteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingVersusInvite {
  token: string;
  inviterName?: string;
  expiresAt: number;
}

interface StoredVersusGuest {
  guestId: string;
  expiresAt: number;
}

function browserInviteStorage(): InviteStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage: InviteStorage | null | undefined): InviteStorage | null {
  return storage === undefined ? browserInviteStorage() : storage;
}

function removeStoredInvite(storage: InviteStorage): void {
  try {
    storage.removeItem(PENDING_VERSUS_INVITE_STORAGE_KEY);
    for (const key of LEGACY_PENDING_VERSUS_INVITE_STORAGE_KEYS) storage.removeItem(key);
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

export function sanitizeVersusRoomCodeInput(value: string): string {
  return [...value.toUpperCase()]
    .filter((character) => VERSUS_ROOM_CODE_ALPHABET.includes(character))
    .join('')
    .slice(0, 6);
}

export function normalizeVersusRoomCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return VERSUS_ROOM_CODE_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeVersusInviteToken(value: string): string | null {
  const normalized = value.trim();
  return VERSUS_INVITE_TOKEN_PATTERN.test(normalized) ? normalized : null;
}

export function versusInviteTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get('invite');
  return token ? normalizeVersusInviteToken(token) : null;
}

export function normalizeVersusInviterName(value: string): string | null {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? Array.from(normalized).slice(0, 48).join('') : null;
}

export function versusInviterNameFromSearch(search: string): string | null {
  const inviterName = new URLSearchParams(search).get('from');
  return inviterName ? normalizeVersusInviterName(inviterName) : null;
}

export function versusInvitedFighterNameFromSearch(search: string): string | null {
  const fighterName = new URLSearchParams(search).get('fighter');
  return fighterName ? normalizeVersusInviterName(fighterName) : null;
}

function randomVersusGuestId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function getOrCreateVersusGuestId(
  token: string,
  storage?: InviteStorage | null,
  now = Date.now(),
  createId: () => string = randomVersusGuestId,
): string | null {
  const normalizedToken = normalizeVersusInviteToken(token);
  if (!normalizedToken) return null;
  const target = resolveStorage(storage);
  const storageKey = `${VERSUS_GUEST_ID_STORAGE_KEY_PREFIX}${normalizedToken}`;
  if (target) {
    try {
      const raw = target.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredVersusGuest>;
        if (
          typeof parsed.guestId === 'string'
          && /^[A-Za-z0-9_-]{20,64}$/.test(parsed.guestId)
          && typeof parsed.expiresAt === 'number'
          && parsed.expiresAt > now
        ) {
          return parsed.guestId;
        }
      }
    } catch {
      // A fresh ephemeral id still lets locked-down browsers join this session.
    }
  }

  const guestId = createId();
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(guestId)) return null;
  if (target) {
    try {
      target.setItem(storageKey, JSON.stringify({
        guestId,
        expiresAt: now + PENDING_VERSUS_INVITE_TTL_MS,
      } satisfies StoredVersusGuest));
    } catch {
      // The id remains usable for the current page even when storage is unavailable.
    }
  }
  return guestId;
}

export function storePendingVersusInvite(
  token: string,
  inviterName?: string | null,
  storage?: InviteStorage | null,
  now = Date.now(),
): boolean {
  const normalized = normalizeVersusInviteToken(token);
  const target = resolveStorage(storage);
  if (!normalized || !target) return false;
  const pending: PendingVersusInvite = {
    token: normalized,
    expiresAt: now + PENDING_VERSUS_INVITE_TTL_MS,
  };
  const normalizedInviterName = inviterName ? normalizeVersusInviterName(inviterName) : null;
  if (normalizedInviterName) pending.inviterName = normalizedInviterName;
  try {
    target.setItem(PENDING_VERSUS_INVITE_STORAGE_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function readPendingVersusInvite(
  storage?: InviteStorage | null,
  now = Date.now(),
): PendingVersusInvite | null {
  const target = resolveStorage(storage);
  if (!target) return null;
  try {
    const raw = target.getItem(PENDING_VERSUS_INVITE_STORAGE_KEY)
      ?? LEGACY_PENDING_VERSUS_INVITE_STORAGE_KEYS
        .map((key) => target.getItem(key))
        .find((value) => value !== null)
      ?? null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingVersusInvite>;
    const token = typeof parsed.token === 'string' ? normalizeVersusInviteToken(parsed.token) : null;
    if (!token || typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now) {
      removeStoredInvite(target);
      return null;
    }
    const inviterName = typeof parsed.inviterName === 'string'
      ? normalizeVersusInviterName(parsed.inviterName)
      : null;
    return inviterName
      ? { token, inviterName, expiresAt: parsed.expiresAt }
      : { token, expiresAt: parsed.expiresAt };
  } catch {
    removeStoredInvite(target);
    return null;
  }
}

export function clearPendingVersusInvite(storage?: InviteStorage | null): void {
  const target = resolveStorage(storage);
  if (target) removeStoredInvite(target);
}
