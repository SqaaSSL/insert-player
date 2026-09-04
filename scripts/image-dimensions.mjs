import { readFileSync } from 'node:fs';

export function readImageSize(path) {
  const bytes = readFileSync(path);
  const isPng = bytes.length >= 24
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
  if (isPng) {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame && segmentLength >= 7 && offset + segmentLength <= bytes.length) {
        return {
          width: bytes.readUInt16BE(offset + 5),
          height: bytes.readUInt16BE(offset + 3),
        };
      }
      if (segmentLength < 2) break;
      offset += segmentLength;
    }
  }

  const isWebp = bytes.length >= 30
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (isWebp) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunk = bytes.toString('ascii', offset, offset + 4);
      const chunkLength = bytes.readUInt32LE(offset + 4);
      const dataOffset = offset + 8;
      if (chunk === 'VP8X' && dataOffset + 10 <= bytes.length) {
        return {
          width: 1 + bytes.readUIntLE(dataOffset + 4, 3),
          height: 1 + bytes.readUIntLE(dataOffset + 7, 3),
        };
      }
      if (chunk === 'VP8L' && dataOffset + 5 <= bytes.length && bytes[dataOffset] === 0x2f) {
        const b0 = bytes[dataOffset + 1];
        const b1 = bytes[dataOffset + 2];
        const b2 = bytes[dataOffset + 3];
        const b3 = bytes[dataOffset + 4];
        return {
          width: 1 + b0 + ((b1 & 0x3f) << 8),
          height: 1 + ((b1 & 0xc0) >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
        };
      }
      if (
        chunk === 'VP8 '
        && dataOffset + 10 <= bytes.length
        && bytes[dataOffset + 3] === 0x9d
        && bytes[dataOffset + 4] === 0x01
        && bytes[dataOffset + 5] === 0x2a
      ) {
        return {
          width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
          height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff,
        };
      }
      offset = dataOffset + chunkLength + (chunkLength % 2);
    }
  }

  throw new Error(`${path} is not a supported PNG, JPEG, or WebP file.`);
}
