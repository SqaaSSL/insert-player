import { afterEach, describe, expect, it, vi } from 'vitest';
import { auraVideoFile, auraVideoShareData, canShareAuraVideo, downloadAuraVideo } from './AuraMatchShare.ts';
import type { AuraVideoRecording } from '../../game/aura/AuraVideoRecorder.ts';

const VIDEO_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01, 0xfe, 0xff]);

function recording(mimeType = 'video/webm;codecs=vp9,opus'): AuraVideoRecording {
  return { blob: new Blob([VIDEO_BYTES], { type: mimeType }), mimeType, hasAudio: true };
}

function downloadHarness() {
  vi.useFakeTimers();
  const events: string[] = [];
  const anchor = {
    href: '', download: '',
    click: vi.fn(() => { events.push('click'); }),
    remove: vi.fn(() => { events.push('remove'); }),
  };
  const createElement = vi.fn(() => anchor);
  const appendChild = vi.fn(() => { events.push('append'); });
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local-aura-video');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => { events.push('revoke'); });
  vi.stubGlobal('document', { createElement, body: { appendChild } });
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout });
  return { anchor, events, createElement, appendChild, createUrl, revokeUrl };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Aura video file', () => {
  it.each([
    ['video/mp4', 'video/mp4', 'mp4'],
    ['VIDEO/MP4;codecs=avc1.42001e,mp4a.40.2', 'video/mp4', 'mp4'],
    [' video/webm ; codecs=vp8,opus', 'video/webm', 'webm'],
    ['video/webm;codecs=vp9', 'video/webm', 'webm'],
  ])('uses the encoded %s container, not a fixed MP4 extension', async (mimeType, type, extension) => {
    const source = recording(mimeType);
    const file = auraVideoFile(source, 'Francisco', 'Trump');
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe(type);
    expect(file.name).toBe(`Insert-Player-Francisco-vs-Trump.${extension}`);
    expect(file.size).toBe(source.blob.size);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(VIDEO_BYTES);
    expect(source.mimeType).toBe(mimeType);
  });

  it.each(['', 'video/quicktime', 'video/mp4evil', 'audio/mp4', 'image/png', 'application/octet-stream'])
    ('refuses unknown MIME %s instead of mislabelling the container', mimeType => {
      expect(() => auraVideoFile(recording(mimeType), 'P1', 'P2')).toThrow('Unknown video format');
    });

  it('normalizes names and removes path separators, markup, controls and compatibility characters', () => {
    const file = auraVideoFile(recording(), '../Ána / O’Connor', '..\\ＢＯＢ<script>\n\u0000');
    expect(file.name).toBe('Insert-Player-Ana-O-Connor-vs-BOB-script.webm');
    expect(file.name).not.toMatch(/[<>/\\\u0000-\u001f]/);
    expect(file.name).not.toContain('..');
  });

  it('bounds each player name and uses a safe fallback for empty or nonfilename names', () => {
    expect(auraVideoFile(recording(), 'A'.repeat(400), '😎💥 / ..').name)
      .toBe(`Insert-Player-${'A'.repeat(40)}-vs-player.webm`);
    expect(auraVideoFile(recording('video/mp4'), '', ' \n ').name)
      .toBe('Insert-Player-player-vs-player.mp4');
  });
});

describe('Aura native file-share support', () => {
  it('attaches Insert Player identity and the chosen playable challenge without altering or uploading video bytes', () => {
    const file = auraVideoFile(recording(), 'P1', 'P2');
    const challenge = { title: '1,000 AURA · Insert Player', text: 'Alex set 1,000 AURA on Insert Player.', url: 'https://api.insertplayer.ai/challenges/aura/example' };
    expect(auraVideoShareData(file, challenge)).toEqual({ title: 'Insert Player · Aura Battle', text: challenge.text, url: challenge.url, files: [file] });
    expect(auraVideoShareData(file)).toMatchObject({ title: 'Insert Player · Aura Battle', url: 'https://insertplayer.ai/games/aura', files: [file] });
  });
  it('checks support for the exact file without opening a share sheet', () => {
    const file = auraVideoFile(recording(), 'P1', 'P2');
    const share = vi.fn();
    const canShare = vi.fn(() => true);
    vi.stubGlobal('navigator', { share, canShare });
    expect(canShareAuraVideo(file)).toBe(true);
    expect(canShare).toHaveBeenCalledExactlyOnceWith({ files: [file] });
    expect(share).not.toHaveBeenCalled();
  });

  it.each([
    ['neither API', {}],
    ['share without file capability', { share: vi.fn() }],
    ['capability without share', { canShare: vi.fn(() => true) }],
    ['invalid share API', { share: true, canShare: vi.fn(() => true) }],
    ['no navigator', undefined],
  ])('returns false for %s', (_name, navigatorValue) => {
    vi.stubGlobal('navigator', navigatorValue);
    expect(canShareAuraVideo(auraVideoFile(recording(), 'P1', 'P2'))).toBe(false);
  });

  it('returns false when this video format is unsupported', () => {
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: vi.fn(() => false) });
    expect(canShareAuraVideo(auraVideoFile(recording(), 'P1', 'P2'))).toBe(false);
  });

  it('contains a throwing capability check or browser API getter', () => {
    const file = auraVideoFile(recording(), 'P1', 'P2');
    vi.stubGlobal('navigator', {
      share: vi.fn(), canShare: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError'); }),
    });
    expect(canShareAuraVideo(file)).toBe(false);
    vi.stubGlobal('navigator', { get share() { throw new Error('API inaccessible'); } });
    expect(canShareAuraVideo(file)).toBe(false);
  });
});

describe('Aura local video download', () => {
  it('clicks an attached anchor, removes it, and keeps its URL alive until the delayed revoke', () => {
    const h = downloadHarness();
    const file = auraVideoFile(recording(), 'P1', 'P2');
    downloadAuraVideo(file);
    expect(h.createUrl).toHaveBeenCalledExactlyOnceWith(file);
    expect(h.createElement).toHaveBeenCalledExactlyOnceWith('a');
    expect(h.appendChild).toHaveBeenCalledExactlyOnceWith(h.anchor);
    expect(h.anchor.href).toBe('blob:local-aura-video');
    expect(h.anchor.download).toBe(file.name);
    expect(h.events).toEqual(['append', 'click', 'remove']);
    expect(h.revokeUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59_999);
    expect(h.revokeUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:local-aura-video');
  });

  it('revokes each download URL on its own deadline without prematurely invalidating a later click', () => {
    const h = downloadHarness();
    h.createUrl.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
    const file = auraVideoFile(recording(), 'P1', 'P2');
    downloadAuraVideo(file);
    vi.advanceTimersByTime(30_000);
    downloadAuraVideo(file);
    vi.advanceTimersByTime(30_000);
    expect(h.revokeUrl.mock.calls).toEqual([['blob:first']]);
    vi.advanceTimersByTime(30_000);
    expect(h.revokeUrl.mock.calls).toEqual([['blob:first'], ['blob:second']]);
  });

  it('propagates object-URL creation failure for the UI fallback without pretending a download started', () => {
    const h = downloadHarness();
    h.createUrl.mockImplementation(() => { throw new Error('Object URL unavailable'); });
    expect(() => downloadAuraVideo(auraVideoFile(recording(), 'P1', 'P2'))).toThrow('Object URL unavailable');
    expect(h.createElement).not.toHaveBeenCalled();
    expect(h.anchor.click).not.toHaveBeenCalled();
    expect(h.revokeUrl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
