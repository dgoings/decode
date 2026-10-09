// `codeviz trace browser`: drive or attach to Chromium over CDP, poll precise coverage + sampling profiler per tick.
import type { Browser, CDPSession, Page } from 'playwright';
import { createTraceWriter, countsToTuples, edgesToTuples, type TraceHeader, type TraceTick } from './format.ts';
import { bucketProfile, resolveProfileFrames, ScriptMapper, type CpuProfile } from './profile.ts';
import type { RepoPaths } from './sourcemap.ts';

export class PlaywrightMissing extends Error {}

export interface BrowserTraceOptions {
  url?: string;
  attach?: number;
  out: string;
  paths: RepoPaths;
  sha: string;
  repoId?: string;
  tickMs: number;
  durationS?: number;
  headless: boolean;
  log: (s: string) => void;
}

export interface BrowserTraceResult {
  ticks: number;
  files: Set<string>;
  edges: Set<string>;
  dropped: number;
  droppedUrls: Map<string, number>;
  warnings: string[];
}

interface ScriptCoverage {
  scriptId: string;
  url: string;
  functions: { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[] }[];
}

type PlaywrightModule = typeof import('playwright');

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    // Variable specifier keeps bundlers from resolving it; playwright is an optional dev dependency.
    const name = 'playwright';
    return (await import(name)) as PlaywrightModule;
  } catch {
    throw new PlaywrightMissing(
      'Playwright is not installed: run `bun add -d playwright && bunx playwright install chromium` in the codeviz checkout',
    );
  }
}

export async function traceBrowser(o: BrowserTraceOptions): Promise<BrowserTraceResult> {
  const pw = await loadPlaywright();
  let browser: Browser;
  let page: Page;
  if (o.attach !== undefined) {
    browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${o.attach}`);
    const pages = browser.contexts().flatMap((c) => c.pages());
    const match = o.url ? pages.filter((p) => p.url().startsWith(o.url!)) : [];
    page = match[0] ?? pages[pages.length - 1] ?? (await (browser.contexts()[0] ?? (await browser.newContext())).newPage());
    o.log(`attached to ${page.url() || 'about:blank'} on port ${o.attach}`);
  } else {
    browser = await pw.chromium.launch({ headless: o.headless });
    page = await (await browser.newContext()).newPage();
  }

  const session: CDPSession = await page.context().newCDPSession(page);
  const mapRefs = new Map<string, string>();
  session.on('Debugger.scriptParsed', (e: { scriptId: string; sourceMapURL?: string }) => {
    if (e.sourceMapURL) mapRefs.set(e.scriptId, e.sourceMapURL);
  });
  await session.send('Debugger.enable');
  await session.send('Debugger.setSkipAllPauses', { skip: true });
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 1000 });
  await session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  await session.send('Profiler.start');

  const mapper = new ScriptMapper(o.paths);
  const getSource = async (scriptId: string) =>
    ((await session.send('Debugger.getScriptSource', { scriptId })) as { scriptSource: string }).scriptSource;

  const started = Date.now();
  const header: TraceHeader = {
    format: 'codeviz-trace',
    version: 1,
    ...(o.repoId ? { repoId: o.repoId } : {}),
    sha: o.sha,
    startedAt: new Date(started).toISOString(),
    tickMs: o.tickMs,
    source: 'browser',
  };
  const writer = createTraceWriter(o.out);
  writer.write(header);
  const result: BrowserTraceResult = {
    ticks: 0,
    files: new Set(),
    edges: new Set(),
    dropped: 0,
    droppedUrls: new Map(),
    warnings: mapper.warnings,
  };

  let stopped = false;
  let wake: () => void = () => {};
  const stop = () => {
    stopped = true;
    wake();
  };
  process.once('SIGINT', stop);
  page.once('close', stop);
  browser.once('disconnected', stop);
  if (o.durationS) setTimeout(stop, o.durationS * 1000).unref();

  const tick = async (): Promise<void> => {
    const t = Date.now() - started;
    const cov = (await session.send('Profiler.takePreciseCoverage')) as { result: ScriptCoverage[] };
    const { profile } = (await session.send('Profiler.stop')) as { profile: CpuProfile };
    if (!stopped) await session.send('Profiler.start');

    const files = new Map<string, number>();
    const fns = new Map<string, number>();
    let dropped = 0;
    for (const sc of cov.result) {
      const calls = sc.functions.reduce((s, f) => s + (f.ranges[0]?.count ?? 0), 0);
      if (!calls) continue;
      if (!sc.url) {
        dropped += calls;
        continue;
      }
      await mapper.prepare(sc.scriptId, sc.url, () => getSource(sc.scriptId), mapRefs.get(sc.scriptId));
      for (const f of sc.functions) {
        const r = f.ranges[0];
        if (!r || !r.count) continue;
        const path = mapper.locateOffset(sc.scriptId, sc.url, r.startOffset);
        if (!path) {
          dropped += r.count;
          result.droppedUrls.set(sc.url, (result.droppedUrls.get(sc.url) ?? 0) + r.count);
          continue;
        }
        files.set(path, (files.get(path) ?? 0) + r.count);
        const k = `${path}\0${f.functionName || '(module)'}`;
        fns.set(k, (fns.get(k) ?? 0) + r.count);
      }
    }
    const fileOf = await resolveProfileFrames(profile, mapper, (key) => getSource(key));
    const [bucket] = bucketProfile(profile, fileOf, Number.MAX_SAFE_INTEGER);
    const edges = bucket?.edges ?? new Map<string, number>();

    const rec: TraceTick = {
      t,
      files: countsToTuples(files),
      edges: edgesToTuples(edges),
      functions: countsToTuples(fns).map(([k, n]) => {
        const [p, name] = k.split('\0') as [string, string];
        return [p, name, n];
      }),
      dropped,
    };
    writer.write(rec);
    result.ticks++;
    result.dropped += dropped;
    for (const [p] of rec.files) result.files.add(p);
    for (const [a, b] of rec.edges) result.edges.add(`${a} -> ${b}`);
  };

  const navigation = o.attach === undefined && o.url ? page.goto(o.url).catch((err: Error) => {
    o.log(`navigation failed: ${err.message}`);
    stop();
  }) : undefined;

  o.log(o.durationS ? `tracing for ${o.durationS}s (Ctrl-C to stop early)` : 'tracing; Ctrl-C or close the page to stop');
  let next = started + o.tickMs;
  for (;;) {
    if (!stopped) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, Math.max(0, next - Date.now()));
      });
    }
    next += o.tickMs;
    if (page.isClosed() || !browser.isConnected()) break;
    try {
      await tick(); // after stop() this is the final, partial tick
    } catch (err) {
      if (!stopped) o.log(`tick failed: ${(err as Error).message}`);
    }
    if (stopped) break;
  }
  await navigation;
  process.removeListener('SIGINT', stop);
  await writer.close();
  try {
    await session.send('Profiler.stopPreciseCoverage');
    await session.detach();
  } catch {
    // page or browser already gone
  }
  await browser.close().catch(() => {});
  return result;
}
