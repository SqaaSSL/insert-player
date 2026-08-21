export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const IMAGE_EXTENSIONS: Record<SupportedImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function detectImageMime(bytes: Uint8Array): SupportedImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export async function imageBlobFile(blob: Blob, basename: string): Promise<File> {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const mime = detectImageMime(header);
  if (!mime) throw new Error(`${basename} is not a supported PNG, JPEG, or WebP image`);
  return new File([blob], `${basename}.${IMAGE_EXTENSIONS[mime]}`, { type: mime });
}
