import { describe, expect, it } from 'vitest';
import {
  assertCreationFlowAcknowledged,
  creationFlowForResume,
  videoCreationFlowAvailability,
} from './creationFlow';

describe('creation flow UI safeguards', () => {
  it('defaults legacy jobs to Original but preserves an explicit Video job', () => {
    expect(creationFlowForResume(undefined)).toBe('original');
    expect(creationFlowForResume('video')).toBe('video');
  });

  it('refuses to resume an unknown flow as Original', () => {
    expect(() => creationFlowForResume('future-flow')).toThrow(/unsupported .*creation flow/i);
  });

  it('keeps Original compatible with a server from before flow acknowledgements', () => {
    expect(() => assertCreationFlowAcknowledged('original', undefined)).not.toThrow();
    expect(() => assertCreationFlowAcknowledged('original', 'original')).not.toThrow();
  });

  it('requires an exact Video acknowledgement before starting a job', () => {
    expect(() => assertCreationFlowAcknowledged('video', undefined)).toThrow(/not enabled/i);
    expect(() => assertCreationFlowAcknowledged('video', 'original')).toThrow(/different creation flow/i);
    expect(() => assertCreationFlowAcknowledged('video', 'video')).not.toThrow();
  });

  it('offers Video only to signed-in Champion generations', () => {
    expect(videoCreationFlowAvailability('signed-in', 'champion')).toEqual({ available: true });
    expect(videoCreationFlowAvailability('signed-in', 'contender')).toEqual({
      available: false,
      reason: 'Choose Champion quality to use Video.',
    });
    expect(videoCreationFlowAvailability('signed-out', 'champion')).toEqual({
      available: false,
      reason: 'Sign in to use the cloud Video flow.',
    });
  });
});
