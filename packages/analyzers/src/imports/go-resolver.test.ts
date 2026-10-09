import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { goAdapter } from '../adapters/go.ts';
import { createGoResolver } from './go-resolver.ts';

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/x\n\ngo 1.22\n\nrequire github.com/foo/bar v1.0.0\n',
  'cmd/app/main.go': `package main

import (
	"fmt"

	"example.com/x/internal/a"
	bar "github.com/foo/bar"
)

func main() { fmt.Println(a.A(), bar.X) }
`,
  'internal/a/a.go': 'package a\n\nimport "example.com/x/internal/b"\n\nfunc A() int { return b.B() }\n',
  'internal/a/a_test.go': 'package a_test\n\nimport (\n\t"testing"\n\t"example.com/x/internal/a"\n\t_ "example.com/x/cmd/app"\n)\n\nfunc TestA(t *testing.T) { _ = a.A() }\n',
  // Internal test file: stays in package a.
  'internal/a/internal_test.go': 'package a\n\nimport "testing"\n\nfunc TestInternal(t *testing.T) {}\n',
  'internal/b/b.go': 'package b\n\nfunc B() int { return 1 }\n',
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeviz-gores-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [name, body] of Object.entries(FILES)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  execFileSync('git', ['add', '.'], { cwd: dir });
  return dir;
}

test('go resolver and package graph: intra-module, stdlib, third-party', async () => {
  const root = repo();
  const r = createGoResolver(root, Object.keys(FILES));
  expect(r.resolve('cmd/app/main.go', 'example.com/x/internal/a')).toEqual({ kind: 'module', id: 'example.com/x/internal/a' });
  expect(r.resolve('cmd/app/main.go', 'example.com/x/internal/missing')).toEqual({ kind: 'unresolved' });
  expect(r.resolve('cmd/app/main.go', 'fmt')).toEqual({ kind: 'external', name: 'fmt' });
  expect(r.resolve('x.go', 'net/http')).toEqual({ kind: 'external', name: 'net' });
  expect(r.resolve('cmd/app/main.go', 'github.com/foo/bar/sub')).toEqual({ kind: 'external', name: 'github.com/foo/bar' });

  const logs: string[] = [];
  const snap = await goAdapter.analyze(root, { ref: { sha: 'x', ref: 'HEAD' }, since: '', log: (m) => logs.push(m) });
  expect(snap.languages).toEqual({ go: 'baseline' });
  expect(snap.modules).toEqual([
    { id: 'example.com/x/cmd/app', kind: 'package', files: ['cmd/app/main.go'] },
    { id: 'example.com/x/internal/a', kind: 'package', files: ['internal/a/a.go', 'internal/a/internal_test.go'] },
    { id: 'example.com/x/internal/a_test', kind: 'package', files: ['internal/a/a_test.go'] },
    { id: 'example.com/x/internal/b', kind: 'package', files: ['internal/b/b.go'] },
  ]);
  expect(snap.edges).toEqual([
    { from: 'example.com/x/cmd/app', to: 'example.com/x/internal/a', kind: 'import', level: 'module' },
    { from: 'example.com/x/internal/a', to: 'example.com/x/internal/b', kind: 'import', level: 'module' },
    { from: 'example.com/x/internal/a_test', to: 'example.com/x/internal/a', kind: 'import', level: 'module' },
    { from: 'example.com/x/internal/a_test', to: 'example.com/x/cmd/app', kind: 'import', level: 'module' },
  ]);
  // a_test -> cmd/app -> a would be a cycle if a_test were folded into a.
  const pairs = new Set(snap.edges!.map((e) => `${e.from} ${e.to}`));
  expect(snap.edges!.filter((e) => pairs.has(`${e.to} ${e.from}`))).toEqual([]);
  expect(logs).toEqual([]);
});
