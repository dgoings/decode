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
// Instrumentation: for each matching module the onLoad hook transpiles TS/TSX to JS with
// Bun.Transpiler, parses that with acorn, and splices one `__cv_h(<id>);` call as the first statement
// of every function body (function declarations/expressions, arrows, methods, class-field arrows;
// expression-bodied arrows become `(__cv_h(<id>), expr)`). No binding is renamed, moved or wrapped,
// so function identity, `const`, own properties and toString() are unchanged. It also appends one
// module-load hit. `__cv_h` counts calls per function and, on a random 1-in-N call, records
// caller-file -> this-file from new Error().stack (weighted ×N in the trace).
// If transpiling or parsing fails, the module is loaded untouched (one stderr line) and not counted.
// JavaScriptCore drops the caller frame of strict-mode tail calls (`return f(x)`), so those edges are missed.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { parse } from 'acorn';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const rawRoot: string = env.CODEVIZ_TRACE_ROOT ?? run(['rev-parse', '--show-toplevel'], process.cwd()) ?? process.cwd();
  let ROOT: string = resolve(rawRoot);
  try {
    ROOT = realpathSync(ROOT); // Bun reports real paths to onLoad
  } catch {
    // keep the resolved path
  }
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
  const stats = { modules: 0, functions: 0, calls: 0, samples: 0, sampleMs: 0, transformMs: 0, flushMs: 0, gitMs: 0, ticks: 0, postErrors: 0 };
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
    let sawCallee = false;
    for (const line of lines) {
      const m = /\(?((?:file:\/\/)?\/[^()]+?):\d+:\d+\)?\s*$/.exec(line);
      if (!m) continue;
      const path = m[1]!.replace(/^file:\/\//, '');
      if (path === harnessFile) continue;
      // First non-harness frame is the instrumented function itself; the next one is its caller.
      if (!sawCallee) {
        sawCallee = true;
        continue;
      }
      const rel = relOf(path);
      if (rel && rel !== callee) edges.set(`${rel}\0${callee}`, (edges.get(`${rel}\0${callee}`) ?? 0) + SAMPLE);
      break; // only the immediate caller frame
    }
    stats.sampleMs += performance.now() - t0;
  };

  const hit = (id: number): void => {
    const c = counters[id]!;
    c.n++;
    // Random (not every-Nth) so a fixed call pattern per request cannot alias onto one function.
    if (SAMPLE === 1 || Math.random() * SAMPLE < 1) callerFile(c.file);
  };

  const transpilers = new Map<string, any>();
  const transpiler = (loader: string): any => {
    let t = transpilers.get(loader);
    if (!t) {
      let tsconfig: string | undefined;
      try {
        tsconfig = readFileSync(`${ROOT}/tsconfig.json`, 'utf8');
      } catch {
        tsconfig = undefined;
      }
      try {
        t = new B.Transpiler({ loader, target: 'bun', ...(tsconfig ? { tsconfig } : {}) });
      } catch {
        t = new B.Transpiler({ loader, target: 'bun' });
      }
      transpilers.set(loader, t);
    }
    return t;
  };

  const nameOf = (node: any, parent: any): string => {
    if (node.id?.name) return node.id.name;
    if (!parent) return '<anonymous>';
    const key = (k: any): string | undefined => (k?.type === 'Identifier' || k?.type === 'PrivateIdentifier' ? k.name : k?.type === 'Literal' ? String(k.value) : undefined);
    if (parent.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
    if (parent.type === 'AssignmentExpression') return parent.left.type === 'Identifier' ? parent.left.name : (key(parent.left.property) ?? '<anonymous>');
    if (parent.type === 'MethodDefinition' || parent.type === 'Property' || parent.type === 'PropertyDefinition') {
      const k = key(parent.key) ?? '<computed>';
      return parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ${k}` : k;
    }
    if (parent.type === 'ExportDefaultDeclaration') return 'default';
    return '<anonymous>';
  };

  /** Transpile to JS, then splice a counter call into every function body (offsets spliced back to front). */
  const instrument = (src: string, rel: string, loader: string): string => {
    const js: string = loader === 'js' ? src : transpiler(loader).transformSync(src);
    const ast = parse(js, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true });
    const edits: [number, string][] = [];
    const visit = (node: any, parent: any): void => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        const id = counters.push({ file: rel, name: nameOf(node, parent), n: 0 }) - 1;
        stats.functions++;
        const body = node.body;
        if (body.type === 'BlockStatement') {
          let at = body.start + 1;
          for (const st of body.body) {
            if (st.type === 'ExpressionStatement' && st.directive !== undefined) at = st.end;
            else break;
          }
          edits.push([at, `__cv_h(${id});`]);
        } else {
          edits.push([body.start, `(__cv_h(${id}), `], [body.end, ')']);
        }
      }
      for (const k in node) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (Array.isArray(v)) for (const c of v) visit(c, node);
        else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, node);
      }
    };
    visit(ast, undefined);
    // Back to front so earlier offsets stay valid; ties keep insertion order reversed (')' after '(…').
    edits.sort((a, b) => b[0] - a[0]);
    let out = js;
    for (const [at, text] of edits) out = out.slice(0, at) + text + out.slice(at);
    // Same line as the first statement: no line shift for stack traces.
    return `var __cv_h=globalThis.__codevizTrace.hit;${out}\n;globalThis.__codevizTrace.load(${JSON.stringify(rel)});\n`;
  };

  const flush = async (final = false): Promise<void> => {
    const t0 = performance.now();
    const files = new Map<string, number>(loads);
    loads.clear();
    const byFn = new Map<string, number>();
    for (const c of counters) {
      if (!c.n) continue;
      stats.calls += c.n;
      files.set(c.file, (files.get(c.file) ?? 0) + c.n);
      const k = `${c.file}\0${c.name}`;
      byFn.set(k, (byFn.get(k) ?? 0) + c.n);
      c.n = 0;
    }
    const fns = [...byFn].map(([k, n]) => [...(k.split('\0') as [string, string]), n] as [string, string, number]);
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
    const id = counters.push({ file: '(calibration)', name: 'noop', n: 0 }) - 1;
    const noop = (x: number) => x + 1;
    const counted = (x: number) => (hit(id), x + 1);
    const N = 200_000;
    let x = 0;
    let t = performance.now();
    for (let i = 0; i < N; i++) x = noop(x);
    const base = performance.now() - t;
    const s = stats.samples;
    const sm = stats.sampleMs;
    t = performance.now();
    for (let i = 0; i < N; i++) x = counted(x);
    const total = performance.now() - t - (stats.sampleMs - sm);
    stats.samples = s;
    stats.sampleMs = sm;
    edges.clear();
    counters.pop();
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
      `[codeviz-trace] ${stats.modules} modules, ${stats.functions} functions instrumented, ${stats.calls} calls, ${stats.samples} stack samples (1/${SAMPLE}), ${stats.ticks} ticks -> ${OUT_FILE ?? OUT_URL}\n` +
        `[codeviz-trace] overhead est. ${overhead.toFixed(1)} ms over ${(uptime / 1000).toFixed(1)} s uptime: git ${stats.gitMs.toFixed(1)} ms, transform ${stats.transformMs.toFixed(1)} ms, counting ${countingMs.toFixed(1)} ms (~${ns.toFixed(0)} ns/call), stack sampling ${stats.sampleMs.toFixed(1)} ms, flush ${stats.flushMs.toFixed(1)} ms`,
    );
  };

  g.__codevizTrace = {
    hit,
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
        const before = counters.length;
        try {
          const out = instrument(contents, rel, loader);
          stats.modules++;
          return { contents: out, loader: 'js' };
        } catch (err) {
          // Never turn a loadable module into a failing one: drop this file's counters, load it untouched.
          stats.functions -= counters.length - before;
          counters.length = before;
          console.error(`[codeviz-trace] not instrumenting ${rel}: ${(err as Error).message}`);
          return { contents, loader };
        } finally {
          stats.transformMs += performance.now() - t0;
        }
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
