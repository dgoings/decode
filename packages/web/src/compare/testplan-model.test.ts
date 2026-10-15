import { expect, test } from 'bun:test';
import type { TestPlan } from '@codeviz/core';
import { allSteps, isWorktreeKey, plural, richParts, screenSteps, stepKey } from './testplan-model.ts';

const step = (file: string, text: string) => ({ kind: 'click' as const, text, why: 'w', file, line: 1 });
const plan: TestPlan = {
  base: { sha: 'b', ref: 'b' },
  head: { sha: 'h', ref: 'h' },
  entries: 2,
  changed: 3,
  ignored: 0,
  impact: {
    screens: [
      {
        entry: { path: 'pages/a.tsx', route: '/a' },
        nearest: 1,
        reached: [
          { file: 'ui/Save.tsx', hops: 1, chain: ['pages/a.tsx', 'ui/Save.tsx'], shared: false },
          { file: 'ui/Button.tsx', hops: 2, chain: ['pages/a.tsx', 'ui/Save.tsx', 'ui/Button.tsx'], shared: true },
          { file: 'lib/none.ts', hops: 2, chain: ['pages/a.tsx', 'lib/none.ts'], shared: false },
        ],
      },
    ],
    shared: [{ file: 'ui/Button.tsx', screens: 6 }],
    unreached: [],
  },
  steps: { 'ui/Save.tsx': [step('ui/Save.tsx', 'Click "Save"')], 'ui/Button.tsx': [step('ui/Button.tsx', 'Click "OK"')] },
};

test('richParts marks backticked spans as code', () => {
  expect(richParts('where `error` is true')).toEqual([
    { code: false, text: 'where ' },
    { code: true, text: 'error' },
    { code: false, text: ' is true' },
  ]);
  expect(richParts('plain')).toEqual([{ code: false, text: 'plain' }]);
});

test('ticks for a WORKTREE head are recognised so they can be dropped', () => {
  expect(isWorktreeKey(stepKey('abc', 'WORKTREE', step('f', 't')))).toBe(true);
  expect(isWorktreeKey(stepKey('abc', 'def', step('f', 't')))).toBe(false);
  expect(isWorktreeKey(stepKey('WORKTREE', 'def', step('f', 't')))).toBe(false);
});

test('allSteps keeps same-text steps from different lines apart', () => {
  const p = { ...plan, steps: { ...plan.steps, 'ui/Save.tsx': [step('ui/Save.tsx', 'Click "Save"'), { ...step('ui/Save.tsx', 'Click "Save"'), line: 20 }] } };
  expect(allSteps(p).filter((s) => s.text === 'Click "Save"')).toHaveLength(2);
});

test('screenSteps skips shared files and files without steps; allSteps adds shared ones once', () => {
  expect(screenSteps(plan, plan.impact.screens[0]!).map((g) => g.file)).toEqual(['ui/Save.tsx']);
  expect(allSteps(plan).map((s) => s.text)).toEqual(['Click "Save"', 'Click "OK"']);
});

test('stepKey and plural', () => {
  expect(stepKey('a', 'b', step('f', 't'))).toBe('a\nb\nf\n1\nt');
  // Two buttons with identical wording on different lines are different steps.
  expect(stepKey('a', 'b', { ...step('f', 't'), line: 9 })).not.toBe(stepKey('a', 'b', step('f', 't')));
  expect(plural(1, 'screen')).toBe('1 screen');
  expect(plural(2, 'screen')).toBe('2 screens');
});
