import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tsLanguages, walkRepo } from '../walker/index.ts';
import { buildFileGraph, createBaselineTsResolver } from './index.ts';

const FIXTURE: Record<string, string> = {
  'tsconfig.base.json': `{
  // JSON5-ish: comments and trailing commas
  "compilerOptions": {
    "paths": { "@app/*": ["src/*"], },
  },
}`,
  'tsconfig.json': `{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true } }`,
  'index.js': `const m = require('./src/main');\n`,
  'src/main.ts': `import { a } from './a';
import { lib } from './lib';
import { b } from './b.js';
import { C } from '@app/c';
import React from 'react';
import { x } from '@scope/pkg/sub';
import fs from 'node:fs';
import path from 'path';
export { d } from './d';
const lazy = () => import('./lazy');
const old = require('./old.cjs');
import { nope } from './missing';
import { a as again } from './a.ts';
import './styles.css';
`,
  'src/a.ts': `import { main } from './main';\nimport './a';\nexport const a = 1;\n`,
  'src/b.ts': `export const b = 2;\n`,
  'src/c.tsx': `export const C = () => <div />;\n`,
  'src/d.ts': `export const d = 4;\n`,
  'src/lazy.ts': `export default 5;\n`,
  'src/old.cjs': `module.exports = 6;\n`,
  'src/lib/index.ts': `export const lib = 7;\n`,
  'src/styles.css': `body {}\n`,
};

function makeFixture(): { root: string; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'codeviz-imports-'));
  for (const [rel, src] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  return { root, files: Object.keys(FIXTURE) };
}

describe('baseline TS resolver', () => {
  const { root, files } = makeFixture();
  const resolver = createBaselineTsResolver(root, files);
  const r = (spec: string, from = 'src/main.ts') => resolver.resolve(from, spec);

  test('resolves relative, index, .js->.ts, paths alias, packages, and misses', () => {
    expect(resolver.tier).toBe('baseline');
    expect(r('./a')).toEqual({ kind: 'file', path: 'src/a.ts' });
    expect(r('./lib')).toEqual({ kind: 'file', path: 'src/lib/index.ts' });
    expect(r('./b.js')).toEqual({ kind: 'file', path: 'src/b.ts' });
    expect(r('@app/c')).toEqual({ kind: 'file', path: 'src/c.tsx' });
    expect(r('@app/lib')).toEqual({ kind: 'file', path: 'src/lib/index.ts' });
    expect(r('./old.cjs')).toEqual({ kind: 'file', path: 'src/old.cjs' });
    expect(r('./src/main', 'index.js')).toEqual({ kind: 'file', path: 'src/main.ts' });
    expect(r('react')).toEqual({ kind: 'external', name: 'react' });
    expect(r('@scope/pkg/sub')).toEqual({ kind: 'external', name: '@scope/pkg' });
    expect(r('node:fs')).toEqual({ kind: 'external', name: 'node:fs' });
    expect(r('path')).toEqual({ kind: 'external', name: 'path' });
    expect(r('bun:test')).toEqual({ kind: 'external', name: 'bun:test' });
    expect(r('npm:@supabase/supabase-js@2')).toEqual({ kind: 'external', name: '@supabase/supabase-js' });
    expect(r('npm:google-auth-library@9/sub')).toEqual({ kind: 'external', name: 'google-auth-library' });
    expect(r('https://deno.land/std@0.168.0/http/server.ts')).toEqual({ kind: 'external', name: 'deno.land' });
    expect(r('./missing')).toEqual({ kind: 'unresolved' });
    expect(r('virtual:thing')).toEqual({ kind: 'unresolved' });
    expect(r('@app/missing')).toEqual({ kind: 'unresolved' });
    expect(r('../../outside')).toEqual({ kind: 'unresolved' });
  });

  test('extracts imports and builds file edges and dir modules', async () => {
    const walked = await walkRepo(root, tsLanguages, files, { imports: true });
    const imports = walked.imports ?? [];
    const kinds = Object.fromEntries(imports.filter((i) => i.file === 'src/main.ts').map((i) => [i.specifier, i.kind]));
    expect(kinds).toMatchObject({ './a': 'import', './d': 'export', './lazy': 'dynamic', './old.cjs': 'require' });
    expect(imports.find((i) => i.specifier === './missing')?.line).toBe(12);

    const analyzed = (walked.files ?? []).map((f) => f.path);
    const graph = buildFileGraph(imports, resolver, analyzed);
    const edges = graph.edges.map((e) => `${e.from} -> ${e.to}`).sort();
    expect(edges).toEqual([
      'index.js -> src/main.ts',
      'src/a.ts -> src/main.ts',
      'src/main.ts -> src/a.ts',
      'src/main.ts -> src/b.ts',
      'src/main.ts -> src/c.tsx',
      'src/main.ts -> src/d.ts',
      'src/main.ts -> src/lazy.ts',
      'src/main.ts -> src/lib/index.ts',
      'src/main.ts -> src/old.cjs',
    ]);
    expect(graph.edges.every((e) => e.kind === 'import' && e.level === 'file')).toBe(true);
    expect(graph.unresolved).toBe(1);
    expect(graph.externals).toEqual({ react: 1, '@scope/pkg': 1, 'node:fs': 1, path: 1 });
    expect(graph.modules).toEqual([
      { id: '.', kind: 'dir', files: ['index.js'] },
      { id: 'src', kind: 'dir', files: ['src/main.ts', 'src/a.ts', 'src/b.ts', 'src/c.tsx', 'src/d.ts', 'src/lazy.ts', 'src/old.cjs'] },
      { id: 'src/lib', kind: 'dir', files: ['src/lib/index.ts'] },
    ]);
  });
});

describe('baseline TS resolver: workspace packages', () => {
  const ws: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    'packages/core/package.json': JSON.stringify({ name: '@x/core', main: 'src/index.ts' }),
    'packages/core/src/index.ts': 'export const core = 1;\n',
    'packages/core/src/util.ts': 'export const util = 1;\n',
    'packages/web/package.json': JSON.stringify({ name: '@x/web', exports: { '.': { import: './dist/index.js' } } }),
    'packages/web/dist/index.ts': 'export const web = 1;\n',
    'packages/cli/package.json': JSON.stringify({ name: '@x/cli' }),
    'packages/cli/src/a.ts': "import { core } from '@x/core';\nimport { util } from '@x/core/src/util.js';\n",
  };
  const root = mkdtempSync(join(tmpdir(), 'codeviz-ws-'));
  for (const [rel, src] of Object.entries(ws)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  const resolver = createBaselineTsResolver(root, Object.keys(ws));
  const r = (spec: string) => resolver.resolve('packages/cli/src/a.ts', spec);

  test('resolves workspace names and subpaths to in-repo files', () => {
    expect(r('@x/core')).toEqual({ kind: 'file', path: 'packages/core/src/index.ts' });
    expect(r('@x/core/src/util.js')).toEqual({ kind: 'file', path: 'packages/core/src/util.ts' });
    expect(r('@x/web')).toEqual({ kind: 'file', path: 'packages/web/dist/index.ts' });
    expect(r('@x/core/missing')).toEqual({ kind: 'external', name: '@x/core' });
    expect(r('react')).toEqual({ kind: 'external', name: 'react' });
  });
});
