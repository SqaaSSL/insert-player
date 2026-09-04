import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  SPRITE_VERSION_CONTENT_INDEX_CONTRACT_COLUMN,
  SPRITE_VERSION_CONTENT_INDEX_CONTRACT_SQL,
  spriteVersionContentIndexContractPassed,
} from './live-readiness-sprite-schema.mjs';

const TABLE_SQL = `
  CREATE TABLE sprite_versions (
    fighter_id TEXT NOT NULL,
    animation_name TEXT NOT NULL,
    quality_tier TEXT NOT NULL,
    animation_format TEXT NOT NULL DEFAULT 'legacy',
    frame_w INTEGER NOT NULL,
    frame_h INTEGER NOT NULL,
    frame_count INTEGER NOT NULL,
    processing_version INTEGER NOT NULL,
    content_hash TEXT,
    raw_content_hash TEXT
  );
`;

const OLD_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_sprite_versions_content
  ON sprite_versions (
    fighter_id,
    animation_name,
    quality_tier,
    content_hash,
    COALESCE(raw_content_hash, '')
  )
  WHERE content_hash IS NOT NULL;
`;

const CURRENT_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_sprite_versions_content
  ON sprite_versions (
    fighter_id,
    animation_name,
    quality_tier,
    animation_format,
    frame_w,
    frame_h,
    frame_count,
    processing_version,
    content_hash,
    COALESCE(raw_content_hash, '')
  )
  WHERE content_hash IS NOT NULL;
`;

function contractValue(indexSql = '') {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`${TABLE_SQL}\n${indexSql}`);
    const row = db.prepare(SPRITE_VERSION_CONTENT_INDEX_CONTRACT_SQL).get();
    return row[SPRITE_VERSION_CONTENT_INDEX_CONTRACT_COLUMN];
  } finally {
    db.close();
  }
}

describe('live-readiness sprite version content index contract', () => {
  it('fails when idx_sprite_versions_content is missing', () => {
    expect(contractValue()).toBe(0);
  });

  it('fails for the old hash-only content index', () => {
    expect(contractValue(OLD_INDEX_SQL)).toBe(0);
  });

  it('passes when the index includes format, frame metadata, processing version, and hashes', () => {
    expect(contractValue(CURRENT_INDEX_SQL)).toBe(1);
  });

  it('only accepts a successful Wrangler result with the positive contract row', () => {
    expect(spriteVersionContentIndexContractPassed({
      status: 0,
      stdout: JSON.stringify({
        results: [{ [SPRITE_VERSION_CONTENT_INDEX_CONTRACT_COLUMN]: 1 }],
      }),
    })).toBe(true);
    expect(spriteVersionContentIndexContractPassed({
      status: 0,
      stdout: JSON.stringify({
        results: [{ [SPRITE_VERSION_CONTENT_INDEX_CONTRACT_COLUMN]: 0 }],
      }),
    })).toBe(false);
    expect(spriteVersionContentIndexContractPassed({
      status: 1,
      stdout: JSON.stringify({
        results: [{ [SPRITE_VERSION_CONTENT_INDEX_CONTRACT_COLUMN]: 1 }],
      }),
    })).toBe(false);
  });
});
