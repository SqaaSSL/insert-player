const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787';

interface ApiUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  eloRating: number;
  wins: number;
  losses: number;
  winStreak: number;
}

interface ApiCharacter {
  id: string;
  user_id: string;
  name: string;
  photo_hash: string;
  sprite_r2_key: string | null;
  intro_r2_key: string | null;
  side_view_r2_key: string | null;
  sprite_status: 'pending' | 'processing' | 'ready' | 'error';
  created_at: string;
}

interface LeaderboardEntry {
  id: string;
  display_name: string;
  avatar_url: string | null;
  elo_rating: number;
  wins: number;
  losses: number;
  win_rate: number;
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error((body as any).error || `API error ${res.status}`);
  }

  return res.json();
}

export const api = {
  getLoginUrl(): string {
    return `${API_BASE}/auth/google`;
  },

  async getMe(): Promise<ApiUser | null> {
    try {
      const data = await apiFetch<{ user: ApiUser }>('/auth/me');
      return data.user;
    } catch {
      return null;
    }
  },

  async logout(): Promise<void> {
    await apiFetch('/auth/logout', { method: 'POST' });
  },

  async uploadPhoto(file: File, name: string): Promise<ApiCharacter> {
    const formData = new FormData();
    formData.append('photo', file);
    formData.append('name', name);

    const data = await apiFetch<{ character: ApiCharacter }>('/api/characters', {
      method: 'POST',
      body: formData,
    });
    return data.character;
  },

  async getCharacters(): Promise<ApiCharacter[]> {
    const data = await apiFetch<{ characters: ApiCharacter[] }>('/api/characters');
    return data.characters;
  },

  async getCharacter(id: string): Promise<ApiCharacter> {
    const data = await apiFetch<{ character: ApiCharacter }>(`/api/characters/${id}`);
    return data.character;
  },

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const data = await apiFetch<{ leaderboard: LeaderboardEntry[] }>('/api/leaderboard');
    return data.leaderboard;
  },

  async getPlayerStats(userId?: string): Promise<any> {
    const path = userId ? `/api/stats/${userId}` : '/api/stats';
    return apiFetch(path);
  },

  async reportMatch(data: {
    player1Id: string;
    player2Id: string;
    winnerId: string;
    roundsP1: number;
    roundsP2: number;
    duration: number;
    p1CharacterId?: string;
    p2CharacterId?: string;
    isRanked?: boolean;
  }): Promise<void> {
    await apiFetch('/api/matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  getSpriteUrl(r2Key: string): string {
    return `${API_BASE}/sprites/${r2Key}`;
  },
};

export type { ApiUser, ApiCharacter, LeaderboardEntry };
