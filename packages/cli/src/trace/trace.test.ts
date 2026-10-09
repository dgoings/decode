import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertCpuProfile } from './cpuprofile.ts';
import { createTraceWriter, readTrace } from './format.ts';
import { ScriptMapper, type CpuProfile } from './profile.ts';
import { fetchPolicy, fetchText, RepoPaths } from './sourcemap.ts';

const root = join(import.meta.dir, 'fixtures');
const paths = new RepoPaths(root, (rel) => existsSync(join(root, rel)));
let server: Server;
let base = '';
let requests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    const file = join(root, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
    if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'application/json' }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

test('source-map path mapping and cpuprofile conversion', async () => {
  const bundleUrl = `${base}/bundle/bundle.js`;
  const bundle = readFileSync(join(root, 'bundle/bundle.js'), 'utf8');
  const at = (needle: string) => {
    const off = bundle.indexOf(needle);
    const before = bundle.slice(0, off).split('\n');
    return { off, line: before.length - 1, col: before[before.length - 1]!.length };
  };

  // Offsets in the served bundle map back to the original src/ files through bundle.js.map.
  const mapper = new ScriptMapper(paths);
  await mapper.prepare('s1', bundleUrl, () => fetchText(bundleUrl));
  expect(mapper.locateOffset('s1', bundleUrl, at('function heavy').off)).toBe('src/math.ts');
  expect(mapper.locateOffset('s1', bundleUrl, at('function work').off)).toBe('src/util.ts');
  expect(mapper.locateOffset('s1', bundleUrl, at('var ticks').off)).toBe('src/main.ts');
  expect(paths.resolve(join(root, 'node_modules/lib/index.js'))).toBeUndefined();
  expect(paths.resolve('data:text/javascript,1')).toBeUndefined();

  // Fetch policy: loopback + allowed origins only; a refused origin is dropped without any request.
  const policy = fetchPolicy(['https://app.example.com']);
  expect(fetchPolicy(['http://127.0.0.1:4191'], false)('http://127.0.0.1:4192/lib.js.map')).toBe(false);
  expect([policy('http://localhost:3000/a.js'), policy('http://[::1]:1/a'), policy('https://app.example.com/x.js.map')]).toEqual([true, true, true]);
  expect([policy('https://clerk.example.dev/npm/clerk.js'), policy('ws://127.0.0.1/x'), policy('/abs/file.ts')]).toEqual([false, false, true]);
  const before = requests;
  const strict = new ScriptMapper(paths, () => false);
  await strict.prepare('s2', bundleUrl, () => fetchText(bundleUrl));
  expect(strict.locateOffset('s2', bundleUrl, at('function heavy').off)).toBeUndefined();
  expect(requests).toBe(before);

  // Synthetic profile: http bundle frames (mapped) + an absolute-path frame (Bun style) + a node_modules leaf.
  const frame = (functionName: string, url: string, p: { line: number; col: number }, scriptId = '7') => ({
    functionName, url, lineNumber: p.line, columnNumber: p.col, scriptId,
  });
  const timer = at('() => {\n  globalThis');
  const profile: CpuProfile = {
    startTime: 0,
    endTime: 3_000_000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2, 6] },
      { id: 2, callFrame: frame('', bundleUrl, timer), children: [3] },
      { id: 3, callFrame: frame('work', bundleUrl, at('function work')), children: [4, 5] },
      { id: 4, callFrame: frame('heavy', join(root, 'src/math.ts'), { line: 1, col: 0 }, '0') },
      { id: 5, callFrame: frame('dep', join(root, 'node_modules/dep/index.js'), { line: 0, col: 0 }, '0') },
      { id: 6, callFrame: { functionName: '(program)', url: '', lineNumber: -1, columnNumber: -1 } },
    ],
    samples: [4, 4, 5, 6, 3],
    timeDeltas: [100_000, 200_000, 300_000, 100_000, 1_500_000],
  };
  const r = await convertCpuProfile(profile, { paths, sha: 'abc', tickMs: 1000, startedAt: new Date(0).toISOString() });
  expect(r.header).toMatchObject({ format: 'codeviz-trace', version: 1, sha: 'abc', source: 'cpuprofile', tickMs: 1000 });
  expect(r.ticks.map((t) => t.t)).toEqual([0, 1000, 2000]);
  expect(r.ticks[0]!.files).toEqual([
    ['src/main.ts', 3],
    ['src/util.ts', 3],
    ['src/math.ts', 2],
  ]);
  expect(r.ticks[0]!.edges).toEqual([
    ['src/main.ts', 'src/util.ts', 3],
    ['src/util.ts', 'src/math.ts', 2],
  ]);
  expect(r.ticks[0]!.dropped).toBe(1);
  expect(r.ticks[1]!.files).toEqual([]);
  expect(r.ticks[2]!.files).toEqual([
    ['src/main.ts', 1],
    ['src/util.ts', 1],
  ]);

  // gzip round trip
  const dir = mkdtempSync(join(tmpdir(), 'codeviz-trace-'));
  try {
    const w = createTraceWriter(join(dir, 't.jsonl.gz'));
    w.write(r.header);
    for (const t of r.ticks) w.write(t);
    await w.close();
    expect(readTrace(join(dir, 't.jsonl.gz'))).toEqual({ header: r.header, ticks: r.ticks });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
