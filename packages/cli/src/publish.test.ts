import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAdapters, registerBuiltinAdapters } from '@codeviz/analyzers';
import { publishCommand } from './commands/publish.ts';
import { estimateDeployPayload } from './publish.ts';

let tmp: string;
let repo: string;
let web: string;
let server: http.Server;
const seenAuth: string[] = [];
const saved = { cwd: process.cwd(), env: { ...process.env } };
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();

beforeAll(async () => {
  clearAdapters();
  registerBuiltinAdapters();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-publish-test-')));
  repo = path.join(tmp, 'repo');
  web = path.join(tmp, 'web');
  fs.mkdirSync(repo);
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>stub</title>');
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'b.ts'), "import { a } from './a';\nexport const b = a + 1;\n");
  git('add', '.');
  git('commit', '-qm', 'two');

  // Fake home with a token, fake sites API, fake particles CLI first on PATH. Nothing real is contacted.
  fs.mkdirSync(path.join(tmp, 'home', '.particles'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'home', '.particles', 'token'), 'fake-token\n');
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(
    path.join(tmp, 'bin', 'particles'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(tmp, 'args.txt')}"\necho 'Deploying 4 files to "taken"... done'\necho '  → https://taken.example.test  (3.0 KB, v2)'\n`,
    { mode: 0o755 },
  );
  server = http.createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization));
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        sites: [{ name: 'taken', deployer: 'someone@example.com', size_bytes: 2048, last_deployed_at: '2026-01-02T03:04:05Z' }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  process.env.HOME = path.join(tmp, 'home');
  process.env.XDG_CACHE_HOME = path.join(tmp, 'cache');
  process.env.PATH = `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH}`;
  process.env.CODEVIZ_PARTICLES_HOST = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.TMPDIR = path.join(tmp, 'tmpdir');
  fs.mkdirSync(process.env.TMPDIR);
  process.chdir(repo);
});

afterAll(() => {
  process.chdir(saved.cwd);
  for (const k of ['HOME', 'XDG_CACHE_HOME', 'PATH', 'CODEVIZ_PARTICLES_HOST', 'TMPDIR']) {
    if (saved.env[k] === undefined) delete process.env[k];
    else process.env[k] = saved.env[k];
  }
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run publish capturing stdout/stderr, with stdin forced to non-TTY. */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const log = console.log;
  const error = console.error;
  const write = process.stdout.write.bind(process.stdout);
  const tty = process.stdin.isTTY;
  let out = '';
  let err = '';
  console.log = (...a: unknown[]) => void (out += a.join(' ') + '\n');
  console.error = (...a: unknown[]) => void (err += a.join(' ') + '\n');
  process.stdout.write = ((d: string | Uint8Array) => ((out += d.toString()), true)) as typeof process.stdout.write;
  process.stdin.isTTY = false as true;
  try {
    const code = await publishCommand([...args, '--since', '1y', '--web-dir', web]);
    return { code, out, err };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
    process.stdin.isTTY = tty;
  }
}

const tempDirsLeft = () => fs.readdirSync(process.env.TMPDIR!).filter((n) => n.startsWith('codeviz-publish-'));

test('estimateDeployPayload skips data/ and node_modules/ and sizes files as base64', () => {
  const d = path.join(tmp, 'payload');
  fs.mkdirSync(path.join(d, 'data'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(d, 'snapshots'));
  fs.writeFileSync(path.join(d, 'data', 'big.bin'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(d, 'node_modules', 'x', 'i.js'), 'x');
  fs.writeFileSync(path.join(d, 'index.html'), Buffer.alloc(10));
  fs.writeFileSync(path.join(d, 'snapshots', 'a.json.gz'), Buffer.alloc(3));
  const p = estimateDeployPayload(d);
  expect(p.files).toBe(2);
  expect(p.bytes).toBe(13);
  expect(p.base64Bytes).toBe(16 + 4); // ceil(10/3)*4 + ceil(3/3)*4
  expect(p.perFile.map((f) => f.path).sort()).toEqual(['index.html', 'snapshots/a.json.gz']);
});

test('refuses an oversize payload with a per-ref breakdown and a drop suggestion', async () => {
  const r = await run(['fresh-site', 'HEAD~1', 'HEAD', '--max-size', '0.001', '--yes']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('site status: new');
  expect(r.err).toContain('exceeds the 0.001 MB limit');
  expect(r.err).toMatch(/[0-9a-f]{12} [0-9a-f]{7} +snapshot .* compare/);
  expect(r.err).toMatch(/suggestion: drop|even a single ref/);
  expect(fs.existsSync(path.join(tmp, 'args.txt'))).toBe(false);
  expect(tempDirsLeft()).toEqual([]);
});

test('non-TTY without --yes refuses before deploying', async () => {
  const r = await run(['fresh-site', 'HEAD']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('repository:  repo');
  expect(r.err).toContain('aborted: not a terminal; pass --yes');
  expect(fs.existsSync(path.join(tmp, 'args.txt'))).toBe(false);
  expect(tempDirsLeft()).toEqual([]);
});

test('--yes runs particles deploy, warns about overwriting, prints the URL and cleans up', async () => {
  const r = await run(['taken', 'HEAD~1', 'HEAD', '--yes']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('will OVERWRITE existing site "taken" deployed by someone@example.com');
  expect(r.out).toContain('codeviz publish: published https://taken.example.test');
  const args = fs.readFileSync(path.join(tmp, 'args.txt'), 'utf8').trim().split('\n');
  expect(args[0]).toBe('deploy');
  expect(args[1]).toStartWith(path.join(tmp, 'tmpdir', 'codeviz-publish-'));
  expect(args[2]).toBe('--name=taken');
  expect(seenAuth.at(-1)).toBe('Bearer fake-token');
  expect(tempDirsLeft()).toEqual([]);
  expect(fs.readdirSync(path.join(tmp, 'home'))).toEqual(['.particles']); // no ~/.config/codeviz
  expect(git('status', '--porcelain')).toBe('');
});
