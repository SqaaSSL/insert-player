import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { serializeAuraTrackCatalog } from './aura-track-catalog-source.mjs';

function readGeneratedData(source) {
  const parsed = ts.createSourceFile('tracks.generated.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  expect(parsed.parseDiagnostics).toEqual([]);
  expect(parsed.statements).toHaveLength(1);
  const statement = parsed.statements[0];
  expect(ts.isVariableStatement(statement)).toBe(true);
  const declarations = statement.declarationList.declarations;
  expect(declarations).toHaveLength(1);
  expect(declarations[0].name.getText(parsed)).toBe('AURA_TRACKS_GENERATED');
  const initializer = declarations[0].initializer;
  expect(ts.isAsExpression(initializer)).toBe(true);
  expect(initializer.type.getText(parsed)).toBe('const');
  expect(ts.isArrayLiteralExpression(initializer.expression)).toBe(true);
  // Parse the complete initializer as data; no execution or removal of escaping.
  return JSON.parse(initializer.expression.getText(parsed));
}

const track = {
  id: 'neon-arena', title: 'Neon Arena', url: '/assets/audio/neon-arena.mp3',
  bpm: 120.5, beatOffsetMs: 0, durationMs: 120_000, stageId: 'insert-player-arena',
};

describe('Aura track catalogue source', () => {
  it('preserves runtime metadata and omits measurement fields and absent optional values', () => {
    const source = serializeAuraTrackCatalog([
      { ...track, confidence: 0.8, fingerprint: '123:456', measuredAt: '2026-09-10' },
      { ...track, durationMs: undefined, stageId: undefined },
    ]);
    const { durationMs, stageId, ...required } = track;
    expect(readGeneratedData(source)).toEqual([track, required]);
    expect(source.endsWith('\n')).toBe(true);
  });

  it.each(Object.keys(track))('keeps quotes, backslashes, newlines and source-like content in %s as literal data', (field) => {
    // A backslash preceding an apostrophe defeated the former quote-only escape.
    // Exercise all dynamic fields, including numeric fields from cached JSON.
    const payload = `\\'; globalThis.auraInjected = true; //\n"quoted"\r\n\\path\\\`\${value}`;
    const input = { ...track, [field]: payload };
    expect(readGeneratedData(serializeAuraTrackCatalog([input]))).toEqual([input]);
  });

  it('generates a valid empty catalogue without measuring or touching audio', () => {
    expect(readGeneratedData(serializeAuraTrackCatalog([]))).toEqual([]);
  });
});
