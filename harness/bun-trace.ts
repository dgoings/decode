// codeviz Bun server trace preload. Runs INSIDE the traced app; never writes into the app repo.
//
//   BUN_OPTIONS="--preload=/abs/path/to/codeviz/harness/bun-trace.ts" bun src/index.tsx
//
// Env:
//   CODEVIZ_TRACE_URL      collector endpoint (default http://127.0.0.1:7357/trace, see `codeviz trace collect`)
//   CODEVIZ_TRACE_FILE     append JSON lines to this file instead of posting (plain JSONL, no gzip)
//   CODEVIZ_TRACE_ROOT     repo root (default: git toplevel of cwd)
//   CODEVIZ_TRACE_FILTER   regex on the repo-relative path of modules to instrument (default ^src/.*\.tsx?$)
//   CODEVIZ_TRACE_TICK_MS  flush interval (default 1000)
//   CODEVIZ_TRACE_SAMPLE   capture the caller file from new Error().stack on 1 in N calls (default 10)
//   CODEVIZ_TRACE_SHA      override `git rev-parse HEAD`
//
// Instrumentation (POC, regex-level, no AST): for each matching module the onLoad hook
//  - counts one "load" call for the file when the module finishes evaluating,
//  - rewrites top-level `const NAME =` to `let   NAME =` (same length, so line/column positions hold),
//  - appends `NAME = wrap(NAME)` for every top-level function declaration and top-level const/let
//    binding (only actual non-class functions get wrapped). The wrapper counts calls per function and
//    on a random 1-in-N call records caller-file -> this-file from the stack (weighted ×N in the trace).
// Calls made through references captured before the module finished evaluating are not counted, and
// JavaScriptCore drops the caller frame of strict-mode tail calls (`return f(x)`), so those edges are missed.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { appendFileSync } from 'node:fs';

const B = (globalThis as any).Bun;
const g = globalThis as any;

if (B && !g.__codevizTrace) setup();

function setup(): void {
  const env = process.env;
  const harnessFile = import.meta.path;
  const run = (args: string[], cwd: string): string | undefined => {
    try {
      const r = B.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
      return r.success ? r.stdout.toString().trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const ROOT: string = (env.CODEVIZ_TRACE_ROOT ?? run(['rev-parse', '--show-toplevel'], process.cwd()) ?? process.cwd()).replace(/\/$/, '');
  const relFilter = env.CODEVIZ_TRACE_FILTER ?? '^src/.*\\.tsx?$';
  const relRe = new RegExp(relFilter);
  const TICK = Number(env.CODEVIZ_TRACE_TICK_MS) || 1000;
  const SAMPLE = Math.max(1, Number(env.CODEVIZ_TRACE_SAMPLE) || 10);
  const OUT_FILE = env.CODEVIZ_TRACE_FILE;
  const DEBUG = !!env.CODEVIZ_TRACE_DEBUG;
  const OUT_URL = env.CODEVIZ_TRACE_URL ?? 'http://127.0.0.1:7357/trace';
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // onLoad must return contents for every match, so the native filter is the user filter anchored at ROOT.
  const loadFilter = new RegExp('^' + escape(ROOT + '/') + (relFilter.startsWith('^') ? relFilter.slice(1) : '.*(?:' + relFilter + ')'));

  interface Counter {
    file: string;
    name: string;
    n: number;
  }
  const counters: Counter[] = [];
  const loads = new Map<string, number>();
  const edges = new Map<string, number>();
  const stats = { modules: 0, wrapped: 0, calls: 0, samples: 0, sampleMs: 0, transformMs: 0, flushMs: 0, gitMs: 0, ticks: 0, postErrors: 0 };
  const started = Date.now();
  let header: string | undefined;

  const relOf = (abs: string): string | undefined => {
    if (!abs.startsWith(ROOT + '/')) return undefined;
    const rel = abs.slice(ROOT.length + 1);
    return rel.includes('node_modules/') ? undefined : rel;
  };

  // Lazily write the header on the first instrumented module (BUN_OPTIONS also reaches `bun run` wrappers).
  const ensureHeader = (): void => {
    if (header) return;
    const t0 = performance.now();
    const sha = env.CODEVIZ_TRACE_SHA ?? run(['rev-parse', 'HEAD'], ROOT) ?? 'unknown';
    const repoId = run(['rev-list', '--max-parents=0', 'HEAD'], ROOT)?.split('\n')[0];
    header = JSON.stringify({
      format: 'codeviz-trace',
      version: 1,
      ...(repoId ? { repoId } : {}),
      sha,
      startedAt: new Date(started).toISOString(),
      tickMs: TICK,
      source: 'server',
    });
    if (OUT_FILE) appendFileSync(OUT_FILE, header + '\n');
    setInterval(() => void flush(), TICK).unref();
    stats.gitMs = performance.now() - t0;
  };

  const callerFile = (callee: string): void => {
    const t0 = performance.now();
    stats.samples++;
    const lines = (new Error().stack ?? '').split('\n');
    if (DEBUG && stats.samples <= 5) console.error(`[codeviz-trace] sample for ${callee}:\n${lines.slice(0, 8).join('\n')}`);
    for (const line of lines) {
      const m = /\(?((?:file:\/\/)?\/[^()]+?):\d+:\d+\)?\s*$/.exec(line);
      if (!m) continue;
      const path = m[1]!.replace(/^file:\/\//, '');
      if (path === harnessFile) continue;
      const rel = relOf(path);
      if (rel && rel !== callee) edges.set(`${rel}\0${callee}`, (edges.get(`${rel}\0${callee}`) ?? 0) + SAMPLE);
      break; // only the immediate caller frame
    }
    stats.sampleMs += performance.now() - t0;
  };

  const wrap = (fn: any, file: string, name: string): any => {
    if (typeof fn !== 'function' || fn.__codeviz) return fn;
    let src = '';
    try {
      src = Function.prototype.toString.call(fn);
    } catch {
      return fn;
    }
    if (/^class\b/.test(src)) return fn;
    const c: Counter = { file, name, n: 0 };
    counters.push(c);
    stats.wrapped++;
    const w = function (this: unknown, ...args: unknown[]) {
      c.n++;
      // Random (not every-Nth) so a fixed call pattern per request cannot alias onto one function.
      if (SAMPLE === 1 || Math.random() * SAMPLE < 1) callerFile(file);
      // eslint-disable-next-line prefer-rest-params
      return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
    };
    try {
      Object.defineProperty(w, 'name', { value: fn.name });
      Object.defineProperty(w, 'length', { value: fn.length });
      Object.defineProperty(w, '__codeviz', { value: true });
      if (fn.prototype) w.prototype = fn.prototype;
      Object.setPrototypeOf(w, fn); // static props read through
    } catch {
      // keep the plain wrapper
    }
    return w;
  };

  const instrument = (src: string, rel: string): string => {
    const names = new Set<string>();
    for (const m of src.matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/gm)) names.add(m[1]!);
    const out = src.replace(/^(export\s+)?const(\s+)([A-Za-z_$][\w$]*)(?=\s*[:=])/gm, (_all, ex: string | undefined, ws: string, name: string) => {
      names.add(name);
      return `${ex ?? ''}let  ${ws}${name}`;
    });
    for (const m of out.matchAll(/^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*[:=]/gm)) names.add(m[1]!);
    const f = JSON.stringify(rel);
    let tail = `\n;globalThis.__codevizTrace?.load(${f});`;
    for (const n of names) tail += `\ntry { ${n} = globalThis.__codevizTrace.wrap(${n}, ${f}, ${JSON.stringify(n)}); } catch {}`;
    return out + tail + '\n';
  };

  const flush = async (final = false): Promise<void> => {
    const t0 = performance.now();
    const files = new Map<string, number>(loads);
    loads.clear();
    const fns: [string, string, number][] = [];
    for (const c of counters) {
      if (!c.n) continue;
      stats.calls += c.n;
      files.set(c.file, (files.get(c.file) ?? 0) + c.n);
      fns.push([c.file, c.name, c.n]);
      c.n = 0;
    }
    const edgeList: [string, string, number][] = [...edges].map(([k, n]) => {
      const [a, b] = k.split('\0') as [string, string];
      return [a, b, n];
    });
    edges.clear();
    if (!header || (!files.size && !edgeList.length)) return;
    const tick = JSON.stringify({
      t: Date.now() - started,
      files: [...files].sort((a, b) => b[1] - a[1]),
      edges: edgeList.sort((a, b) => b[2] - a[2]),
      functions: fns.sort((a, b) => b[2] - a[2]),
    });
    stats.ticks++;
    if (OUT_FILE) appendFileSync(OUT_FILE, tick + '\n');
    else {
      const p = fetch(OUT_URL, { method: 'POST', body: header + '\n' + tick + '\n' }).then(
        () => {},
        () => {
          if (!stats.postErrors++) console.error(`[codeviz-trace] cannot reach collector ${OUT_URL} (run \`codeviz trace collect\`); dropping ticks`);
        },
      );
      if (final) await p;
    }
    stats.flushMs += performance.now() - t0;
  };

  // Rough per-call cost of the counting wrapper (excluding stack samples, timed separately).
  const calibrate = (): number => {
    const noop = (x: number) => x + 1;
    const wrapped = wrap(noop, '(calibration)', 'noop');
    counters.pop();
    stats.wrapped--;
    const N = 200_000;
    let x = 0;
    let t = performance.now();
    for (let i = 0; i < N; i++) x = noop(x);
    const base = performance.now() - t;
    const s = stats.samples;
    const sm = stats.sampleMs;
    t = performance.now();
    for (let i = 0; i < N; i++) x = wrapped(x);
    const total = performance.now() - t - (stats.sampleMs - sm);
    stats.samples = s;
    stats.sampleMs = sm;
    edges.clear();
    return Math.max(0, ((total - base) / N) * 1e6); // ns per call
  };

  let reported = false;
  const report = (): void => {
    if (reported || !header) return;
    reported = true;
    const ns = calibrate();
    const countingMs = (stats.calls * ns) / 1e6;
    const overhead = stats.gitMs + stats.transformMs + countingMs + stats.sampleMs + stats.flushMs;
    const uptime = Date.now() - started;
    console.error(
      `[codeviz-trace] ${stats.modules} modules, ${stats.wrapped} functions wrapped, ${stats.calls} calls, ${stats.samples} stack samples (1/${SAMPLE}), ${stats.ticks} ticks -> ${OUT_FILE ?? OUT_URL}\n` +
        `[codeviz-trace] overhead est. ${overhead.toFixed(1)} ms over ${(uptime / 1000).toFixed(1)} s uptime: git ${stats.gitMs.toFixed(1)} ms, transform ${stats.transformMs.toFixed(1)} ms, counting ${countingMs.toFixed(1)} ms (~${ns.toFixed(0)} ns/call), stack sampling ${stats.sampleMs.toFixed(1)} ms, flush ${stats.flushMs.toFixed(1)} ms`,
    );
  };

  g.__codevizTrace = {
    wrap,
    load(rel: string) {
      loads.set(rel, (loads.get(rel) ?? 0) + 1);
    },
  };

  B.plugin({
    name: 'codeviz-trace',
    setup(build: any) {
      build.onLoad({ filter: loadFilter }, async (args: { path: string; loader?: string }) => {
        const contents: string = await B.file(args.path).text();
        const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
        const loader = ext === 'mts' ? 'ts' : ext === 'mjs' ? 'js' : ext;
        const rel = relOf(args.path);
        if (!rel || !relRe.test(rel)) return { contents, loader };
        ensureHeader();
        const t0 = performance.now();
        stats.modules++;
        const out = instrument(contents, rel);
        stats.transformMs += performance.now() - t0;
        return { contents: out, loader };
      });
    },
  });

  process.on('exit', () => {
    void flush(); // file mode is synchronous; URL mode is best effort here
    report();
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await flush(true);
      report();
      // Only exit ourselves when the app has no handler of its own.
      if (process.listenerCount(sig) === 1) process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}
