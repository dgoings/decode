import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { repoId } from '../repo.ts';
import { PlaywrightMissing, traceBrowser } from '../trace/browser.ts';
import { DEFAULT_COLLECTOR_PORT, runCollector } from '../trace/collect.ts';
import { importCpuProfileFile } from '../trace/cpuprofile.ts';
import { RepoPaths } from '../trace/sourcemap.ts';

export const traceUsage = `codeviz trace browser [<url>] [--attach <port>] [--out <file>] [--root <repo>] [--sha <sha>] [--tick <ms>] [--duration <s>] [--headless]
  codeviz trace import-cpuprofile <file> [--out <file>] [--root <repo>] [--sha <sha>] [--tick <ms>]
  codeviz trace collect [--port <n>] [--out <file>] [--duration <s>]   (receives posts from harness/bun-trace.ts)`;

interface Opts {
  positional: string[];
  out?: string;
  root: string;
  sha?: string;
  tickMs?: number;
  durationS?: number;
  attach?: number;
  port?: number;
  headless: boolean;
}

function parse(args: string[]): Opts | string {
  const o: Opts = { positional: [], root: process.cwd(), headless: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const value = (): string | undefined => (eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : args[++i]);
    const num = (): number | undefined => {
      const v = Number(value());
      return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    if (name === '--headless') o.headless = true;
    else if (name === '--out') o.out = value();
    else if (name === '--root') o.root = resolve(value() ?? '');
    else if (name === '--sha') o.sha = value();
    else if (name === '--tick') {
      if ((o.tickMs = num()) === undefined) return '--tick needs a positive number of ms';
    } else if (name === '--duration') {
      if ((o.durationS = num()) === undefined) return '--duration needs a positive number of seconds';
    } else if (name === '--attach') {
      if ((o.attach = num()) === undefined) return '--attach needs a port';
    } else if (name === '--port') {
      if ((o.port = num()) === undefined) return '--port needs a port';
    } else if (a.startsWith('-')) return `unknown option ${a}`;
    else o.positional.push(a);
  }
  return o;
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function outPath(o: Opts, source: string): string | { error: string } {
  const out = resolve(o.out ?? join(tmpdir(), `codeviz-trace-${source}-${Date.now()}.jsonl.gz`));
  const top = git(o.root, ['rev-parse', '--show-toplevel']);
  if (top) {
    const rel = relative(top, out);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return { error: `refusing to write ${out} inside the analyzed repo ${top}; pass --out elsewhere` };
  }
  return out;
}

function repoInfo(o: Opts): { sha: string; repoId?: string } | { error: string } {
  const sha = o.sha ?? git(o.root, ['rev-parse', 'HEAD']);
  if (!sha) return { error: `cannot determine the SHA for ${o.root} (not a git repo?); pass --sha` };
  let id: string | undefined;
  try {
    id = repoId(o.root);
  } catch {
    id = undefined;
  }
  return { sha, ...(id ? { repoId: id } : {}) };
}

function reportDropped(dropped: number, urls: Map<string, number>, log: (s: string) => void): void {
  if (!dropped) return;
  const byPrefix = new Map<string, number>();
  for (const [u, n] of urls) {
    if (!n) continue;
    const nm = /^(.*?\/node_modules\/(?:@[^/]+\/)?[^/]+)/.exec(u);
    const key = nm ? nm[1]! : u.length > 100 ? u.slice(0, 100) + '…' : u;
    byPrefix.set(key, (byPrefix.get(key) ?? 0) + n);
  }
  const top = [...byPrefix].sort((a, b) => b[1] - a[1]).slice(0, 8);
  log(`dropped ${dropped} calls/samples outside the repo (node_modules, bundler runtime, data:/eval scripts)${top.length ? ':' : ''}`);
  for (const [k, n] of top) log(`  ${n}\t${k}`);
}

export async function traceCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const o = parse(rest);
  if (typeof o === 'string') return fail(`${o}\nusage:\n  ${traceUsage}`, 2);
  const log = (s: string) => console.error(s);

  if (sub === 'collect') {
    const out = resolve(o.out ?? join(tmpdir(), `codeviz-trace-server-${Date.now()}.jsonl.gz`));
    const s = await runCollector({ port: o.port ?? DEFAULT_COLLECTOR_PORT, out, durationS: o.durationS, log });
    console.log(`codeviz trace collect: ${out}  ${s.ticks} tick(s), ${s.files.size} file(s), ${s.edges} edge record(s)`);
    return 0;
  }

  if (sub === 'browser' || sub === 'import-cpuprofile') {
    const info = repoInfo(o);
    if ('error' in info) return fail(info.error);
    const out = outPath(o, sub === 'browser' ? 'browser' : 'cpuprofile');
    if (typeof out !== 'string') return fail(out.error);
    const paths = new RepoPaths(o.root);

    if (sub === 'import-cpuprofile') {
      const [file] = o.positional;
      if (!file) return fail(`expected <file>\nusage:\n  ${traceUsage}`, 2);
      const r = await importCpuProfileFile(file, out, { paths, ...info, tickMs: o.tickMs ?? 1000 });
      for (const w of r.warnings) log(`warning: ${w}`);
      reportDropped(r.dropped, r.droppedUrls, log);
      const files = new Set(r.ticks.flatMap((t) => t.files.map(([p]) => p)));
      const edges = new Set(r.ticks.flatMap((t) => t.edges.map(([a, b]) => `${a}>${b}`)));
      console.log(`codeviz trace import-cpuprofile: ${out}  ${r.ticks.length} tick(s), ${files.size} file(s), ${edges.size} edge(s), sha ${info.sha.slice(0, 7)}`);
      return 0;
    }

    const [url] = o.positional;
    if (!url && o.attach === undefined) return fail(`expected <url> or --attach <port>\nusage:\n  ${traceUsage}`, 2);
    try {
      const r = await traceBrowser({
        url,
        attach: o.attach,
        out,
        paths,
        ...info,
        tickMs: o.tickMs ?? 500,
        durationS: o.durationS,
        headless: o.headless,
        log,
      });
      for (const w of new Set(r.warnings)) log(`warning: ${w}`);
      reportDropped(r.dropped, r.droppedUrls, log);
      console.log(`codeviz trace browser: ${out}  ${r.ticks} tick(s), ${r.files.size} file(s), ${r.edges.size} edge(s), sha ${info.sha.slice(0, 7)}`);
      return 0;
    } catch (err) {
      if (err instanceof PlaywrightMissing) return fail(err.message);
      throw err;
    }
  }

  return fail(`expected a subcommand\nusage:\n  ${traceUsage}`, 2);
}

function fail(msg: string, code = 1): number {
  console.error(`codeviz trace: ${msg}`);
  return code;
}
