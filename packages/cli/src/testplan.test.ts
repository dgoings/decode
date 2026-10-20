import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAdapters, registerBuiltinAdapters } from '@codeviz/analyzers';
import { analyzeRef } from './analyze.ts';
import { planMarkdown } from '@codeviz/core';
import { buildTestPlan, createResolver, readMany } from './testplan.ts';
import { extractUiSync, loadUiParsers } from '@codeviz/analyzers';
import { createServer, type CodevizServer } from './server.ts';

let repo: string;
let cache: string;
const prevCache = process.env.XDG_CACHE_HOME;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const write = (p: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), s);
};

const SAVE = (label: string, body: string) => `import { api } from '../lib/api';
export function SaveButton({ id }: { id: string }) {
  const handleSave = async () => {
    ${body}
  };
  return <button onClick={handleSave}>${label}</button>;
}
`;

beforeAll(() => {
  clearAdapters();
  registerBuiltinAdapters();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-plan-'));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-cache-'));
  process.env.XDG_CACHE_HOME = cache;
  git('init', '-q');
  write('lib/api.ts', 'export const api = { save: (id: string) => id };\n');
  write('components/SaveButton.tsx', SAVE('Save', 'await api.save(id);'));
  write('components/Footer.tsx', 'export function Footer() {\n  return <footer>hi</footer>;\n}\n');
  write(
    'pages/users/[id].tsx',
    "import { SaveButton } from '../../components/SaveButton';\nexport default function User() {\n  return <SaveButton id=\"1\" />;\n}\n",
  );
  write('pages/about.tsx', "import { Footer } from '../components/Footer';\nexport default function About() {\n  return <Footer />;\n}\n");
  git('add', '.');
  git('commit', '-qm', 'one');
  // Same size and complexity: the metric diff calls this file unchanged.
  write('components/SaveButton.tsx', SAVE('Save', 'await api.save(id + 1);'));
  write('lib/api.ts', 'export const api = { save: (id: string) => id, list: () => [] };\n');
  git('commit', '-qam', 'two');
});
afterAll(() => {
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCache;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

test('buildTestPlan maps a handler change to its screen and a click step, even when metrics are unchanged', async () => {
  const plan = await buildTestPlan(repo, 'HEAD~1', 'HEAD', { since: '1y' });
  expect(plan.entries).toBe(2);
  expect(plan.changed).toBe(2);
  expect(plan.impact.screens.map((s) => s.entry.route)).toEqual(['/users/:id']);
  const screen = plan.impact.screens[0]!;
  expect(screen.reached.map((r) => [r.file, r.hops])).toEqual([['components/SaveButton.tsx', 1], ['lib/api.ts', 2]]);
  expect(screen.reached[0]!.chain).toEqual(['pages/users/[id].tsx', 'components/SaveButton.tsx']);
  const save = plan.steps['components/SaveButton.tsx']!;
  expect(save.map((s) => s.kind)).toEqual(['click']);
  expect(save[0]!.text).toBe('Click “Save”');
  expect(save[0]!.area).toBe('Save button');
  expect(save[0]!.why.join(' ')).toContain('handleSave');
  // The flow graph runs from the button through its handler to the library call it makes.
  expect(save[0]!.flow.nodes.map((n) => n.label)).toEqual(['“Save” button', 'handleSave()', 'api.save']);
  expect(save[0]!.flow.nodes[2]).toMatchObject({ file: 'lib/api.ts', changed: true });
  // lib/api.ts has no UI: its changed function is reported instead.
  expect(plan.steps['lib/api.ts']![0]!.kind).toBe('logic');
  expect(plan.impact.unreached).toEqual([]);

  const md = planMarkdown(plan);
  expect(md).toContain('### Users › (id) (`/users/:id`)');
  expect(md).toContain('- [ ] Click “Save” _(Save button)_');
  expect(md).toContain('  - Check: ');
  expect(md).not.toContain('/about');
});

test('--entry globs add screens that file routing misses', async () => {
  write('src/screens/Home.tsx', "import { Footer } from '../../components/Footer';\nexport const Home = () => <Footer />;\n");
  write('components/Footer.tsx', 'export function Footer() {\n  return <footer>bye</footer>;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'three');
  const without = await buildTestPlan(repo, 'HEAD~1', 'HEAD', { since: '1y' });
  expect(without.impact.screens.map((s) => s.entry.route)).toEqual(['/about']);
  const withEntry = await buildTestPlan(repo, 'HEAD~1', 'HEAD', { since: '1y', entries: ['src/screens/*.tsx'] });
  expect(withEntry.impact.screens.map((s) => s.entry.route).sort()).toEqual(['/about', 'src/screens/Home.tsx']);
  expect(withEntry.steps['components/Footer.tsx']![0]).toMatchObject({ kind: 'view' });
});

test('a WORKTREE head sees uncommitted edits and staged new files', async () => {
  write('components/Footer.tsx', 'export function Footer() {\n  return <footer>wip</footer>;\n}\n');
  write('pages/new.tsx', "import { Footer } from '../components/Footer';\nexport default function New() {\n  return <Footer />;\n}\n");
  git('add', 'pages/new.tsx');
  try {
    const { snapshot } = await analyzeRef(repo, 'WORKTREE', { since: '1y' });
    const plan = await buildTestPlan(repo, 'HEAD', 'WORKTREE', { since: '1y', worktree: snapshot });
    expect(plan.head.sha).toBe('WORKTREE');
    expect(plan.impact.screens.map((s) => s.entry.route)).toEqual(['/new', '/about']);
    expect(plan.impact.screens[0]!.reached.map((r) => r.file)).toEqual(['pages/new.tsx', 'components/Footer.tsx']);
  } finally {
    git('rm', '-qf', 'pages/new.tsx');
    git('checkout', '--', '.');
  }
});

test('/api/testplan serves json and markdown and validates its parameters', async () => {
  const server = createServer({ root: repo, since: '1y' });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const md = await fetch(`http://127.0.0.1:${port}/api/testplan?base=HEAD~2&head=HEAD&format=md`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(await md.text()).toContain('`/users/:id`');
    const json = await fetch(`http://127.0.0.1:${port}/api/testplan?base=HEAD~2&head=HEAD`);
    expect((await json.json()).impact.screens.length).toBeGreaterThan(0);
    const again = await fetch(`http://127.0.0.1:${port}/api/testplan?base=HEAD~2&head=HEAD`);
    expect((await again.json()).head.sha).toBe(git('rev-parse', 'HEAD'));
    expect((await fetch(`http://127.0.0.1:${port}/api/testplan?base=HEAD`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/testplan?base=WORKTREE&head=HEAD`)).status).toBe(400);
    const bad = encodeURIComponent('a'.repeat(201));
    expect((await fetch(`http://127.0.0.1:${port}/api/testplan?base=HEAD~2&head=HEAD&entry=${bad}`)).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `entry=a${i}`).join('&');
    expect((await fetch(`http://127.0.0.1:${port}/api/testplan?base=HEAD~2&head=HEAD&${many}`)).status).toBe(400);
  } finally {
    server.close();
  }
});

test('createResolver matches relative paths, aliases and generated-API modules without a bundler', () => {
  const files = ['src/components/Save.tsx', 'src/lib/api.ts', 'src/ui/button/index.tsx', 'convex/taskTags.ts', 'convex/_generated/api.js'];
  const src: Record<string, string> = {
    'convex/taskTags.ts': 'export const list = query({\n  handler: async (ctx) => {\n    return 1;\n  },\n});\n\nexport const create = mutation({\n  handler: async () => {\n    return 2;\n  },\n});\n',
  };
  const r = createResolver(files, (f) => src[f] ?? null, new Map([['convex/taskTags.ts', [{ start: 8, end: 8 }]]]));
  expect(r.importFile('src/components/Save.tsx', '../lib/api')).toBe('src/lib/api.ts');
  expect(r.importFile('src/components/Save.tsx', '@/lib/api')).toBe('src/lib/api.ts');
  expect(r.importFile('src/components/Save.tsx', '@/ui/button')).toBe('src/ui/button/index.tsx');
  expect(r.importFile('src/components/Save.tsx', 'react')).toBeUndefined();
  expect(r.apiModuleFile('src/components/Save.tsx', '../../convex/_generated/api', ['taskTags'])).toBe('convex/taskTags.ts');
  expect(r.apiModuleFile('src/components/Save.tsx', '@/../convex/_generated/api', ['taskTags'])).toBeUndefined();
  expect(r.declSpan('convex/taskTags.ts', 'create')).toEqual({ line: 7, endLine: 11 });
  expect(r.declSpan('convex/taskTags.ts', 'list')).toEqual({ line: 1, endLine: 5 });
  expect(r.changed('convex/taskTags.ts', 7, 11)).toBe(true);
  expect(r.changed('convex/taskTags.ts', 1, 5)).toBe(false);
  expect(r.changed('src/lib/api.ts')).toBe(false);
});

test('createResolver: a real file beats dir/index, and aliases prefer the importer\'s own package', () => {
  const files = ['a/lib/utils.ts', 'a/lib/utils/index.ts', 'pkg-a/src/lib/x.ts', 'pkg-b/src/lib/x.ts', 'pkg-b/src/App.tsx'];
  const r = createResolver(files, () => null, new Map());
  expect(r.importFile('a/main.ts', './lib/utils')).toBe('a/lib/utils.ts');
  expect(r.importFile('pkg-b/src/App.tsx', '@/lib/x')).toBe('pkg-b/src/lib/x.ts');
  expect(r.importFile('pkg-a/src/main.ts', '@/lib/x')).toBe('pkg-a/src/lib/x.ts');
});

test('createResolver.declSpan prefers real declarations and ignores braces in strings, comments and return types', () => {
  const src = [
    'const shape = { create: 1 };',          // 1: loose `create:` must not win
    'const label = "}";',                    // 2
    'export function create(): { a: string } {', // 3: braces balance mid-line, body continues
    '  // } stray',                          // 4
    '  const s = "{";',                      // 5
    '  return { a: "x" };',                  // 6
    '}',                                     // 7
    'export const after = 1;',               // 8
  ].join('\n');
  const r = createResolver(['x.ts'], () => src, new Map());
  expect(r.declSpan('x.ts', 'create')).toEqual({ line: 3, endLine: 7 });
  expect(r.declSpan('x.ts', 'missing')).toBeUndefined();
});

test('createResolver.declSpan handles brace-less arrows, braces in signatures, and never matches a plain call', () => {
  const src = [
    'export const fmt = (x: number) => x + 1',          // 1: no braces anywhere
    'function other() {',                               // 2
    '  return 1;',                                      // 3
    '}',                                                // 4
    'const f = (a: { x: number }) =>',                  // 5: braces balance on the first line, body is next
    '  body(a);',                                       // 6
    'create(args);',                                    // 7: a call, not a declaration
    'const holder = {',                                 // 8
    '  create(ctx) {',                                  // 9
    '    return 1;',                                    // 10
    '  },',                                             // 11
    '};',                                               // 12
  ].join('\n');
  const r = createResolver(['x.ts'], () => src, new Map());
  expect(r.declSpan('x.ts', 'fmt')).toEqual({ line: 1, endLine: 1 });
  expect(r.declSpan('x.ts', 'f')).toEqual({ line: 5, endLine: 6 });
  expect(r.declSpan('x.ts', 'other')).toEqual({ line: 2, endLine: 4 });
  expect(r.declSpan('x.ts', 'create')).toEqual({ line: 9, endLine: 11 });
});

test('createResolver.importFile keeps dotted file names intact', () => {
  const r = createResolver(['lib/api.ts', 'lib/api.client.ts', 'lib/legacy.ts'], () => null, new Map());
  expect(r.importFile('lib/x.ts', './api.client')).toBe('lib/api.client.ts');
  expect(r.importFile('lib/x.ts', './api')).toBe('lib/api.ts');
  expect(r.importFile('lib/x.ts', './legacy.js')).toBe('lib/legacy.ts');
});

test('readMany returns the same text as git show, in one process, and nulls for missing files', async () => {
  const sha = git('rev-parse', 'HEAD');
  const got = await readMany(repo, sha, ['lib/api.ts', 'components/SaveButton.tsx', 'nope.ts']);
  expect(got.get('lib/api.ts')).toBe(fs.readFileSync(path.join(repo, 'lib/api.ts'), 'utf8'));
  expect(got.get('components/SaveButton.tsx')).toContain('handleSave');
  expect(got.get('nope.ts')).toBeNull();
});

test('createResolver.declSpan prefers parsed spans, which survive text the line scanner gets wrong', async () => {
  await loadUiParsers();
  const src = [
    'const note = "unbalanced ) and { in a string";',
    'export const create = mutation({',
    '  args: { create: v.string() },',
    '  handler: async (ctx) => {',
    '    return `}` + "{";',
    '  },',
    '});',
    'const after = 1;',
  ].join('\n');
  const r = createResolver(['x.ts'], () => src, new Map(), (file, text) => extractUiSync(text, file)?.functions ?? []);
  expect(r.declSpan('x.ts', 'create')).toEqual({ line: 2, endLine: 7 });
});

test('own-repo plan: edits between functions are not blamed on a neighbour, deletions are counted, callees in other files are read ahead', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeviz-plan2-'));
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  const w = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), s);
  };
  try {
    g('init', '-q');
    w('lib/util.ts', 'export function a() {\n  return 1;\n}\nexport const CONFIG = 1;\nexport function b() {\n  return 2;\n}\n');
    w('lib/save.ts', 'export function save(id: string) {\n  return id;\n}\n');
    w('pages/index.tsx', "import { save } from '../lib/save';\nexport default function Home() {\n  return <button onClick={() => save('1')}>Save</button>;\n}\n");
    w('pages/old.tsx', 'export default function Old() {\n  return <p>old</p>;\n}\n');
    g('add', '.');
    g('commit', '-qm', 'one');
    w('lib/util.ts', 'export function a() {\n  return 1;\n}\nexport const CONFIG = 2;\nexport function b() {\n  return 2;\n}\n');
    w('pages/index.tsx', "import { save } from '../lib/save';\nexport default function Home() {\n  return <button onClick={() => save('2')}>Save</button>;\n}\n");
    g('rm', '-q', 'pages/old.tsx');
    g('commit', '-qam', 'two');
    const plan = await buildTestPlan(dir, 'HEAD~1', 'HEAD', { since: '1y' });
    expect(plan.steps['lib/util.ts']).toBeUndefined(); // CONFIG sits between a() and b(), inside neither
    // A change inside a handler wrapped by a call (`Route = make({ beforeLoad() {} })`) names the handler, not the wrapper.
    w('lib/route.ts', 'export const Route = make({\n  beforeLoad: () => {\n    return 1;\n  },\n});\n');
    g('add', '.');
    g('commit', '-qm', 'three');
    w('lib/route.ts', 'export const Route = make({\n  beforeLoad: () => {\n    return 2;\n  },\n});\n');
    g('commit', '-qam', 'four');
    const routePlan = await buildTestPlan(dir, 'HEAD~1', 'HEAD', { since: '1y' });
    expect(routePlan.steps['lib/route.ts']!.map((s) => s.text)).toEqual(['Try what uses `beforeLoad`']);
    expect(plan.ignored).toBe(1); // pages/old.tsx was deleted
    const save = plan.steps['pages/index.tsx']![0]!;
    // `save` lives in a file that did not change: it was read ahead and its location resolved.
    expect(save.flow.nodes.find((n) => n.label === 'save')).toMatchObject({ file: 'lib/save.ts', line: 1, changed: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
