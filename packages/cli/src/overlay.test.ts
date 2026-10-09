import { expect, test } from 'bun:test';
import { lcovToOverlay, normalizePath, parseOverlay, unmatchedRows } from './overlay.ts';

test('parseOverlay reads JSON and CSV, normalizes paths like the walker, and counts unmatched rows', () => {
  const json = parseOverlay(
    JSON.stringify({ name: 'coverage', unit: '%', higherIsBetter: true, min: 0, max: 100, rows: [['./src/a.ts', 83.2], ['/repo/src\\b.ts', 50], ['gone.ts', 1]] }),
    'cov.json',
    '/repo',
  );
  expect(json).toEqual({ name: 'coverage', unit: '%', higherIsBetter: true, min: 0, max: 100, rows: [['src/a.ts', 83.2], ['src/b.ts', 50], ['gone.ts', 1]] });
  expect(unmatchedRows(json, ['src/a.ts', 'src/b.ts', 'src/c.ts'])).toBe(1);

  const csv = parseOverlay('path,value\n./src/a.ts,12\n"x,y.ts",3\n', '/tmp/errors.csv');
  expect(csv).toMatchObject({ name: 'errors', unit: '', higherIsBetter: false, rows: [['src/a.ts', 12], ['x,y.ts', 3]] });
  expect(() => parseOverlay('path,value\na.ts,nope\n', 'bad.csv')).toThrow('bad.csv:2');
  expect(() => parseOverlay('{"name":"a b","rows":[]}', 'x.json')).toThrow('overlay name');
  expect(normalizePath('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts');
});

test('lcovToOverlay gives line coverage percent per file, from LF/LH or DA lines', () => {
  const lcov = ['TN:', 'SF:src/a.ts', 'DA:1,1', 'LF:3', 'LH:2', 'end_of_record', 'SF:/repo/src/b.ts', 'DA:1,0', 'DA:2,4', 'end_of_record', 'SF:empty.ts', 'LF:0', 'LH:0', 'end_of_record'].join('\n');
  expect(lcovToOverlay(lcov, '/repo', '/repo')).toEqual({
    name: 'coverage',
    unit: '%',
    higherIsBetter: true,
    min: 0,
    max: 100,
    rows: [['src/a.ts', 66.7], ['src/b.ts', 50]],
  });
});
