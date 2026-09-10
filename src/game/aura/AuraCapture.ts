import type { AuraVideoRecording } from './AuraVideoRecorder.ts';

/** In-memory, same-page delivery only. Never send blobs over match networking. */
export const AURA_CAPTURE_EVENT = 'asf-aura-capture';
export type AuraCaptureDetail = { id: string } & (
  | { state: 'preparing' | 'recording' | 'processing' }
  | { state: 'unavailable'; reason: string }
  | { state: 'ready'; video: AuraVideoRecording }
);

declare global {
  interface WindowEventMap {
    [AURA_CAPTURE_EVENT]: CustomEvent<AuraCaptureDetail>;
  }
}
