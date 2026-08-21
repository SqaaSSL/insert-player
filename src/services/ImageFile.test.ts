import { describe, expect, it } from 'vitest';
import { detectImageMime, imageBlobFile } from './ImageFile.ts';

describe('image MIME normalization', () => {
  it.each([
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0]],
    ['image/webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
  ] as const)('detects %s from bytes', (expected, bytes) => {
    expect(detectImageMime(new Uint8Array(bytes))).toBe(expected);
  });

  it('repairs a stale PNG declaration before upload', async () => {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const staleBlob = new Blob([jpegBytes], { type: 'image/png' });

    const file = await imageBlobFile(staleBlob, 'side_raw');

    expect(file.type).toBe('image/jpeg');
    expect(file.name).toBe('side_raw.jpg');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(jpegBytes);
  });

  it('rejects data that is not a supported image', async () => {
    await expect(imageBlobFile(new Blob(['not-an-image']), 'broken'))
      .rejects.toThrow('not a supported PNG, JPEG, or WebP image');
  });
});
