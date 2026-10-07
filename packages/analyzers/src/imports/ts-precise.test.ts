import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPreciseTsResolver, findTypescript } from './ts-precise.ts';

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeviz-ts-'));
  for (const [f, s] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), s);
  }
  return dir;
}

test('precise resolver: paths/baseUrl, relative, .js suffix, external, builtin', () => {
  const modulePath = dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
      include: ['src'],
    }),
    'src/main.ts': '',
    'src/util.ts': '',
    'src/lib/math.ts': '',
    'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', version: '1.0.0', types: 'index.d.ts' }),
    'node_modules/left-pad/index.d.ts': 'export {};',
    'node_modules/@types/react/package.json': JSON.stringify({ name: '@types/react', version: '19.0.0', types: 'index.d.ts' }),
    'node_modules/@types/react/index.d.ts': 'export {};',
  };
  const root = fixture(files);
  const r = createPreciseTsResolver(root, { modulePath }, Object.keys(files));
  expect(r.tier).toBe('precise');
  expect(r.resolve('src/main.ts', '@lib/math')).toEqual({ kind: 'file', path: 'src/lib/math.ts' });
  expect(r.resolve('src/main.ts', './util')).toEqual({ kind: 'file', path: 'src/util.ts' });
  expect(r.resolve('src/main.ts', './util.js')).toEqual({ kind: 'file', path: 'src/util.ts' });
  expect(r.resolve('src/main.ts', 'left-pad')).toEqual({ kind: 'external', name: 'left-pad' });
  expect(r.resolve('src/main.ts', 'react')).toEqual({ kind: 'external', name: 'react' });
  expect(r.resolve('src/main.ts', 'node:fs')).toEqual({ kind: 'external', name: 'node:fs' });
  expect(r.resolve('src/main.ts', './missing')).toEqual({ kind: 'unresolved' });
});

test('findTypescript: head-reuse only when majors match', () => {
  const head = fixture({ 'node_modules/typescript/package.json': JSON.stringify({ version: '5.6.3' }) });
  const ok = fixture({ 'package.json': JSON.stringify({ devDependencies: { typescript: '^5.4.0' } }) });
  const bad = fixture({ 'package.json': JSON.stringify({ devDependencies: { typescript: '~4.9.5' } }) });
  expect(findTypescript(ok, head)).toEqual({
    modulePath: join(head, 'node_modules', 'typescript'), version: '5.6.3', source: 'head-reuse',
  });
  expect(findTypescript(bad, head)).toBeNull();
});
