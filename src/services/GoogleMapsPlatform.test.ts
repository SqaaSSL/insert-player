import { describe, expect, it } from 'vitest';
import {
  normalizeStreetViewCaptureFrame,
  streetViewFovForZoom,
  streetViewStageLabel,
} from './GoogleMapsPlatform.ts';

describe('GoogleMapsPlatform', () => {
  it('converts panorama zoom to a bounded Street View Static field of view', () => {
    expect(streetViewFovForZoom(0)).toBe(120);
    expect(streetViewFovForZoom(1)).toBe(90);
    expect(streetViewFovForZoom(2)).toBe(45);
    expect(streetViewFovForZoom(20)).toBe(10);
    expect(streetViewFovForZoom(Number.NaN)).toBe(90);
  });

  it('normalizes a capture frame and wraps negative headings', () => {
    expect(normalizeStreetViewCaptureFrame({
      panoId: 'pano_123-abc',
      latitude: 38.541,
      longitude: -0.123,
      heading: -15,
      pitch: 1.234,
      fov: 89.999,
      locationLabel: '  Plaça   del Castell, Benidorm  ',
    })).toEqual({
      panoId: 'pano_123-abc',
      latitude: 38.541,
      longitude: -0.123,
      heading: 345,
      pitch: 1.23,
      fov: 90,
      locationLabel: 'Plaça del Castell, Benidorm',
      imageDate: null,
      copyright: null,
    });
  });

  it('rejects malformed panorama identifiers and impossible coordinates', () => {
    expect(() => normalizeStreetViewCaptureFrame({
      panoId: 'bad pano!',
      latitude: 0,
      longitude: 0,
      heading: 0,
      pitch: 0,
      fov: 90,
    })).toThrow(/identifier/i);
    expect(() => normalizeStreetViewCaptureFrame({
      panoId: 'valid',
      latitude: 91,
      longitude: 0,
      heading: 0,
      pitch: 0,
      fov: 90,
    })).toThrow(/latitude/i);
  });

  it('derives a compact arcade label from the resolved location', () => {
    expect(streetViewStageLabel('Plaça del Castell, Benidorm, Spain')).toBe('PLAÇA DEL CASTELL');
    expect(streetViewStageLabel()).toBe('STREET VIEW STAGE');
  });
});
