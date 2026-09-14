/** Shared public contract. Provider credentials and requests never cross this boundary. */
export const BATTLE_FINISHER_CREDIT_COST = 1;
export const BATTLE_STILL_MAX_BYTES = 3 * 1024 * 1024;
export const BATTLE_RECORDING_MAX_BYTES = 64 * 1024 * 1024;
export interface BattleSummary {
  game: 'fight' | 'aura' | 'rush';
  winner: 'p1' | 'p2' | 'draw' | 'team' | 'rivals';
  /** Actual winner position in this final frame; fighters can cross sides. */
  winnerSide?: 'left' | 'right';
  p1Name: string;
  p2Name: string;
  stageLabel: string;
  stageId?: string;
  durationSeconds: number;
  p1Score?: number;
  p2Score?: number;
  rank?: string;
  seed?: number;
}
export interface BattleFinisher {
  id: string;
  status: 'queued' | 'generating' | 'ready' | 'failed';
  error?: string;
  creditRefunded: boolean;
  videoUrl?: string;
}
export interface SavedBattle {
  id: string;
  summary: BattleSummary;
  createdAt: string;
  published: boolean;
  isOwner: boolean;
  stillUrl: string;
  recordingUrl?: string;
  finisher?: BattleFinisher;
  shareUrl: string;
  finisherShareUrl: string;
  ogImageUrl: string;
}
