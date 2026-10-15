import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { clearAdapters, registerBuiltinAdapters } from '@codeviz/analyzers';
import { decodeSnapshot } from '@codeviz/core';
import { exportCommand } from './commands/export.ts';

let repo: string;
let tmp: string;
const prevCache = process.env.XDG_CACHE_HOME;
const prevCwd = process.cwd();
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();

beforeAll(() => {
  clearAdapters();
  registerBuiltinAdapters();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-export-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  process.env.XDG_CACHE_HOME = path.join(tmp, 'cache');
  fs.mkdirSync(path.join(tmp, 'web', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'web', 'index.html'), '<!doctype html><title>stub</title>');
  fs.writeFileSync(path.join(tmp, 'web', 'assets', 'app.js'), '//stub');
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'b.ts'), "import { a } from './a';\nexport const b = a + 1;\n");
  git('add', '.');
  git('commit', '-qm', 'two');
  process.chdir(repo);
});
afterAll(() => {
  process.chdir(prevCwd);
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCache;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Minimal static file server, like the one a published export sits behind. */
function serveStatic(dir: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(fs.readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    }),
  );
}

test('export writes the web UI, gzip snapshots, index and precomputed compares; refuses WORKTREE', async () => {
  const out = path.join(tmp, 'out');
  const web = path.join(tmp, 'web');
  expect(await exportCommand([out, 'HEAD~1', 'HEAD', '--since', '1y', '--web-dir', web])).toBe(0);

  const base = git('rev-parse', 'HEAD~1');
  const head = git('rev-parse', 'HEAD');
  expect(fs.existsSync(path.join(out, 'index.html'))).toBe(true);
  expect(fs.existsSync(path.join(out, 'assets', 'app.js'))).toBe(true);

  const { url, close } = await serveStatic(out);
  try {
    const index = (await (await fetch(`${url}/snapshots/index.json`)).json()) as Record<string, unknown>;
    expect(index).toMatchObject({ repo: 'repo', head: base, refs: [], worktree: null });
    expect((index.snapshots as { sha: string; ref: string }[]).map((s) => [s.ref, s.sha])).toEqual([
      [base.slice(0, 12), base],
      ['main', head],
    ]);
    for (const sha of [base, head]) {
      const buf = Buffer.from(await (await fetch(`${url}/snapshots/${sha}.json.gz`)).arrayBuffer());
      expect(decodeSnapshot(buf).sha).toBe(sha);
    }
    for (const [b, h] of [
      [base, head],
      [head, base],
    ]) {
      const res = await fetch(`${url}/snapshots/compare/${b}-${h}.json.gz`);
      expect(res.status).toBe(200);
      const diff = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
      expect(diff.base.sha).toBe(b);
      expect(diff.totals.files.added + diff.totals.files.removed).toBe(1);
    }
  } finally {
    close();
  }

  // Non-empty dir is refused without --overwrite, accepted with it.
  expect(await exportCommand([out, 'HEAD', '--since', '1y', '--web-dir', web])).toBe(1);
  fs.writeFileSync(path.join(out, 'assets', 'important.txt'), 'keep me');
  fs.writeFileSync(path.join(out, 'README.md'), 'keep me too');
  expect(await exportCommand([out, 'HEAD', '--since', '1y', '--web-dir', web, '--overwrite'])).toBe(0);
  expect(fs.readdirSync(path.join(out, 'snapshots')).sort()).toEqual([`${head}.json.gz`, 'index.json']);
  expect(fs.readFileSync(path.join(out, 'assets', 'important.txt'), 'utf8')).toBe('keep me');
  expect(fs.existsSync(path.join(out, 'README.md'))).toBe(true);
  expect(fs.existsSync(path.join(out, 'assets', 'app.js'))).toBe(true);

  // Exporting onto (or above) the web build is refused and leaves it intact.
  expect(await exportCommand([web, 'HEAD', '--since', '1y', '--web-dir', web, '--overwrite'])).toBe(1);
  expect(await exportCommand([tmp, 'HEAD', '--since', '1y', '--web-dir', web, '--overwrite'])).toBe(1);
  expect(fs.readdirSync(web).sort()).toEqual(['assets', 'index.html']);

  const refused = path.join(tmp, 'refused');
  expect(await exportCommand([refused, 'HEAD', 'WORKTREE', '--web-dir', web])).toBe(1);
  expect(await exportCommand([refused, 'nope-not-a-ref', '--web-dir', web])).toBe(1);
  expect(fs.existsSync(refused)).toBe(false);
});
