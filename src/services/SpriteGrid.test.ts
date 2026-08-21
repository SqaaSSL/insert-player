import { describe, expect, it } from 'vitest';
import { inferSpriteGridFromSubjects, type SubjectBox } from './SpriteGrid';

function makeGridSubjects(cols: number, rows: number, cellWidth = 210, cellHeight = 316): SubjectBox[] {
  const subjects: SubjectBox[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      subjects.push({
        x: col * cellWidth + 38 + (row % 2),
        y: row * cellHeight + 25 + (col % 2),
        w: 136,
        h: 286,
        area: 16_000 + row * 20 + col * 10,
      });
    }
  }
  return subjects;
}

describe('inferSpriteGridFromSubjects', () => {
  it('detects a 4x4 model output when eight frames were requested', () => {
    const result = inferSpriteGridFromSubjects(843, 1264, makeGridSubjects(4, 4), 8);
    expect(result).toEqual({ cols: 4, rows: 4, subjectCount: 16 });
  });

  it('keeps the prompted grid when the model followed it', () => {
    const result = inferSpriteGridFromSubjects(840, 632, makeGridSubjects(4, 2), 8);
    expect(result).toEqual({ cols: 4, rows: 2, subjectCount: 8 });
  });

  it('rejects detached fragments masquerading as extra rows', () => {
    const bodies = makeGridSubjects(4, 2);
    const fragments = bodies.map((body) => ({
      x: body.x + 20,
      y: body.y + 150,
      w: 70,
      h: 80,
      area: 5_000,
    }));
    const result = inferSpriteGridFromSubjects(840, 632, [...bodies, ...fragments], 8);
    expect(result).toBeNull();
  });

  it('refuses layouts with too few complete subjects', () => {
    const result = inferSpriteGridFromSubjects(840, 632, makeGridSubjects(3, 2), 8);
    expect(result).toBeNull();
  });
});
