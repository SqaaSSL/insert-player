export const SPRITE_VERSION_CONTENT_INDEX_CONTRACT_COLUMN =
  'sprite_version_content_index_contract';

const requiredIndexSqlIdentifiers = [
  'animation_format',
  'frame_w',
  'frame_h',
  'frame_count',
  'processing_version',
  'content_hash',
  'raw_content_hash',
];

export const SPRITE_VERSION_CONTENT_INDEX_CONTRACT_SQL = `
SELECT CASE WHEN COUNT(*) = 1
  AND MAX(CASE WHEN
    ${requiredIndexSqlIdentifiers
      .map((identifier) => `instr(lower(sql), '${identifier}') > 0`)
      .join('\n    AND ')}
  THEN 1 ELSE 0 END) = 1
  THEN 1 ELSE 0 END AS ${SPRITE_VERSION_CONTENT_INDEX_CONTRACT_COLUMN}
FROM sqlite_master
WHERE type = 'index'
  AND name = 'idx_sprite_versions_content'
  AND tbl_name = 'sprite_versions';`;

export function spriteVersionContentIndexContractPassed(result) {
  if (result.status !== 0) return false;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return new RegExp(
    `"${SPRITE_VERSION_CONTENT_INDEX_CONTRACT_COLUMN}"\\s*:\\s*1(?:\\D|$)`,
  ).test(output);
}
