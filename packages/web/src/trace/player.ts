// Trace control strip and playback loop, shared by the Graph and Map views (the strip moves into
// whichever is shown). Playback state lives here; the active view's TraceLayer only restyles.
import type { DataSource, Overlay, Trace, TraceInfo, TraceTick } from '../data.ts';
import type { TraceLayer } from './layer.ts';
import { addTick, advance, decayFactor, emptyHeat, heatAt, insertTick, totals, type EdgeClasses, type Heat, type Totals } from './model.ts';

export interface TracePlayer {
  /** The strip; hidden while no trace is loaded. */
  readonly el: HTMLElement;
  /** Load the trace list (and the initial trace) before the views read mode= from the hash. */
  init(): Promise<void>;
  /** The view to draw on (null when the treemap or compare view is shown). */
  setTarget(layer: TraceLayer | null): void;
  /** Snapshot shown in the views, for the sha-mismatch warning. */
  setSnapshotSha(sha: string | null): void;
  /** Redraw the current moment (the target's elements were rebuilt). */
  redraw(): void;
}

export interface PlayerOptions {
  source: DataSource;
  readParam(key: string): string | null;
  writeParam(key: string, value: string | null): void;
  /** Whole-trace calls per file as the `executed` overlay; null when no trace is selected. */
  onExecuted(overlay: Overlay | null): void;
}

const SPEEDS = [0.5, 1, 2, 4];
const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const fmt = (n: number) => Math.round(n).toLocaleString();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createTracePlayer(opts: PlayerOptions): TracePlayer {
  const { source } = opts;
  const strip = el('div', 'trace-strip');
  strip.hidden = true;
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'Runtime trace');

  const label = el('span', 'trace-label', 'Trace');
  const picker = el('select', 'trace-pick');
  picker.setAttribute('aria-label', 'Trace');
  const play = el('button', 'btn trace-play', '▶ Play');
  play.type = 'button';
  const speedSel = el('select', 'trace-speed');
  speedSel.setAttribute('aria-label', 'Speed');
  for (const s of SPEEDS) {
    const o = el('option', undefined, `${s}x`);
    o.value = String(s);
    speedSel.append(o);
  }
  speedSel.value = '1';
  const scrub = el('input', 'trace-scrub');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.setAttribute('aria-label', 'Time');
  const time = el('span', 'trace-time muted');
  const followLabel = el('label', 'trace-follow');
  const followBox = el('input');
  followBox.type = 'checkbox';
  followBox.checked = true;
  followLabel.append(followBox, ' Follow');
  const decayLabel = el('label', 'trace-decay');
  const decayIn = el('input');
  decayIn.type = 'range';
  decayIn.min = '200';
  decayIn.max = '10000';
  decayIn.step = '100';
  decayIn.value = '2000';
  decayIn.setAttribute('aria-label', 'Decay');
  const decayText = el('span', 'muted', '2.0s');
  decayLabel.append('Decay ', decayIn, decayText);
  const summaryBtn = el('button', 'btn trace-summary', 'Summary');
  summaryBtn.type = 'button';
  summaryBtn.setAttribute('aria-pressed', 'false');
  const warn = el('span', 'trace-warn');
  warn.hidden = true;
  const legend = el('span', 'trace-legend');
  strip.append(label, picker, play, speedSel, scrub, time, followLabel, decayLabel, summaryBtn, warn, legend);

  let list: TraceInfo[] = [];
  const cache = new Map<string, Promise<Trace>>();
  let info: TraceInfo | null = null;
  let trace: Trace | null = null;
  let tot: Totals | null = null;
  let totDirty = false;
  let heat: Heat = emptyHeat();
  let cursor = 0;
  let t = 0;
  let playing = false;
  let speed = 1;
  let decayMs = 2000;
  let summary = false;
  let classes: EdgeClasses | null = null;
  let target: TraceLayer | null = null;
  let snapSha: string | null = null;
  let closeStream: (() => void) | null = null;
  let raf = 0;
  let last = 0;
  let lastHashWrite = 0;
  let loadSeq = 0;

  const duration = () => (trace?.ticks.length ? trace.ticks[trace.ticks.length - 1]!.t : 0);
  const live = () => !!info?.live;
  const following = () => live() && followBox.checked;

  function syncControls(): void {
    const end = Math.max(duration(), t);
    scrub.max = String(Math.max(1, Math.ceil(end)));
    scrub.step = String(Math.max(1, Math.round((trace?.header.tickMs ?? 100) / 10)));
    scrub.value = String(Math.round(t));
    time.textContent = `${fmtS(t)} / ${fmtS(end)}${live() ? ' · live' : ''}`;
    play.textContent = playing ? '❚❚ Pause' : '▶ Play';
    play.setAttribute('aria-pressed', String(playing));
    followLabel.hidden = !live();
    summaryBtn.setAttribute('aria-pressed', String(summary));
    for (const c of [play, speedSel, scrub, followBox, decayIn]) c.disabled = summary;
    const mismatch = info && snapSha && snapSha !== 'WORKTREE' && info.sha !== snapSha;
    warn.hidden = !mismatch;
    if (mismatch) {
      warn.textContent = `⚠ trace is from ${info!.sha.slice(0, 7)}, view shows ${snapSha!.slice(0, 7)}`;
      warn.title = 'Paths usually still match, but files added or moved since then will not light up.';
    }
    renderLegend();
  }

  function swatch(cls: string, text: string): HTMLElement {
    const s = el('span', 'trace-key');
    s.append(el('span', `trace-swatch ${cls}`), text);
    return s;
  }

  function renderLegend(): void {
    if (summary && classes) {
      legend.replaceChildren(
        swatch('called', `import edge with calls (${fmt(classes.called)})`),
        swatch('uncalled', `never called (${fmt(classes.uncalled)})`),
        swatch('runtime', `runtime edge, no import (${fmt(classes.runtimeOnly)})`),
      );
    } else {
      legend.replaceChildren(swatch('node', 'executed'), swatch('called', 'call along import'), swatch('runtime', 'call with no import edge'));
    }
  }

  function writeT(force = false): void {
    const now = performance.now();
    if (!force && now - lastHashWrite < 1000) return;
    lastHashWrite = now;
    opts.writeParam('t', String(Math.round(t)));
  }

  function scaleNow() {
    return { peakFile: tot?.peakFile ?? 1, peakEdge: tot?.peakEdge ?? 1, tickMs: trace?.header.tickMs ?? 1000, decayMs };
  }

  function ensureTotals(): Totals | null {
    if (trace && (!tot || totDirty)) {
      tot = totals(trace.ticks);
      totDirty = false;
    }
    return tot;
  }

  function render(now = performance.now()): void {
    if (!target || !trace) return;
    if (summary) {
      const tt = ensureTotals();
      if (tt) classes = target.summary(tt);
      renderLegend();
    } else target.frame(heat, scaleNow(), now);
  }

  function seek(next: number): void {
    if (!trace) return;
    t = Math.max(0, next);
    ({ heat, cursor } = heatAt(trace.ticks, t, decayMs));
  }

  function loop(now: number): void {
    raf = 0;
    if (!trace || summary) return;
    const dt = last ? now - last : 0;
    last = now;
    if (playing) {
      let t1 = following() ? Math.max(t, Date.now() - Date.parse(trace.header.startedAt)) : t + dt * speed;
      const end = duration();
      if (!live() && t1 >= end) {
        t1 = end;
        playing = false;
      }
      if (live() && !following() && t1 >= end) t1 = Math.max(t, end);
      // A long gap (tab hidden, debugger): rebuild from the trace instead of replaying every tick.
      if (dt > 1000) seek(t1);
      else cursor = advance(heat, trace.ticks, cursor, t, t1, decayMs);
      t = t1;
      writeT(!playing);
    }
    render(now);
    syncControls();
    if (playing) schedule();
  }

  function schedule(): void {
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function setPlaying(on: boolean): void {
    if (!trace) return;
    if (on && !live() && t >= duration()) seek(0);
    playing = on;
    last = 0;
    if (on) schedule();
    else writeT(true);
    syncControls();
  }

  function setSummary(on: boolean): void {
    summary = on;
    opts.writeParam('summary', on ? '1' : null);
    if (on) {
      playing = false;
      totDirty = true;
      const tt = ensureTotals();
      if (tt) opts.onExecuted(executedOverlay(tt));
    }
    render();
    syncControls();
  }

  function onLiveTick(tick: TraceTick): void {
    if (!trace) return;
    const i = insertTick(trace.ticks, tick);
    totDirty = true;
    strip.dataset.ticks = String(trace.ticks.length);
    if (tot) {
      for (const [, n] of tick.files) tot.peakFile = Math.max(tot.peakFile, n);
      for (const [, , n] of tick.edges ?? []) tot.peakEdge = Math.max(tot.peakEdge, n);
    }
    // Already past this moment: add it now, decayed by how late it is.
    if (i < cursor) {
      cursor++;
      addTick(heat, tick, decayFactor(t - tick.t, decayMs));
    }
    if (following() && !playing && !summary) setPlaying(true);
    if (!playing) syncControls();
  }

  async function select(id: string, at: number | null): Promise<void> {
    const seq = ++loadSeq;
    closeStream?.();
    closeStream = null;
    const meta = list.find((x) => x.id === id) ?? null;
    if (!meta) return;
    let loaded: Trace;
    try {
      let p = cache.get(id);
      if (!p || meta.live) cache.set(id, (p = source.trace(id)));
      loaded = await p;
    } catch (err) {
      cache.delete(id);
      warn.hidden = false;
      warn.textContent = `Could not load trace ${id}: ${(err as Error).message}`;
      return;
    }
    if (seq !== loadSeq) return;
    target?.clear();
    info = meta;
    trace = { header: loaded.header, ticks: [...loaded.ticks].sort((a, b) => a.t - b.t) };
    strip.dataset.ticks = String(trace.ticks.length);
    tot = null;
    totDirty = true;
    picker.value = id;
    opts.writeParam('trace', id);
    const tt = ensureTotals();
    opts.onExecuted(tt ? executedOverlay(tt) : null);
    playing = false;
    seek(at ?? (meta.live ? duration() : 0));
    if (meta.live && source.traceStream) closeStream = source.traceStream(id, trace.ticks.length, onLiveTick);
    if (meta.live && followBox.checked && at === null) setPlaying(true);
    render();
    syncControls();
  }

  function fillPicker(): void {
    const cur = picker.value;
    picker.replaceChildren(
      ...list.map((x) => {
        const o = el('option', undefined, `${x.id} · ${x.source} · ${x.live ? 'live' : fmtS(x.durationMs)}`);
        o.value = x.id;
        return o;
      }),
    );
    if (cur && list.some((x) => x.id === cur)) picker.value = cur;
    strip.hidden = list.length === 0;
  }

  async function refreshList(): Promise<void> {
    let next: TraceInfo[];
    try {
      next = await source.traces();
    } catch {
      return;
    }
    const known = new Set(list.map((x) => x.id));
    const added = next.filter((x) => !known.has(x.id));
    list = next;
    if (added.length) fillPicker();
    // A trace showed up (live capture started after the page loaded, or the traced app restarted):
    // select it when nothing is shown yet or when following a live trace.
    const fresh = newestLive(added);
    if (!info && list.length) await select((fresh ?? list[0]!).id, null);
    else if (fresh && info?.live && followBox.checked) await select(fresh.id, null);
  }

  play.addEventListener('click', () => setPlaying(!playing));
  speedSel.addEventListener('change', () => (speed = Number(speedSel.value) || 1));
  scrub.addEventListener('input', () => {
    if (playing && following()) followBox.checked = false;
    seek(Number(scrub.value));
    render();
    syncControls();
  });
  scrub.addEventListener('change', () => writeT(true));
  followBox.addEventListener('change', () => {
    if (followBox.checked) setPlaying(true);
  });
  decayIn.addEventListener('input', () => {
    decayMs = Number(decayIn.value);
    decayText.textContent = fmtS(decayMs);
    seek(t);
    render();
  });
  summaryBtn.addEventListener('click', () => setSummary(!summary));
  picker.addEventListener('change', () => void select(picker.value, null));
  document.addEventListener('visibilitychange', () => {
    last = 0; // resume without a jump in frame time; a long gap reseeks in loop()
    if (!document.hidden && playing) schedule();
  });

  return {
    el: strip,
    async init() {
      try {
        list = await source.traces();
      } catch (err) {
        console.warn(`codeviz: could not load traces: ${(err as Error).message}`);
        list = [];
      }
      fillPicker();
      const want = opts.readParam('trace');
      // trace=<id>, or trace=<n> for the n-th trace (1-based) when no trace has that id.
      const pick =
        list.find((x) => x.id === want) ??
        (want && /^\d+$/.test(want) ? list[Number(want) - 1] : undefined) ??
        newestLive(list) ??
        list[0];
      const at = Number(opts.readParam('t'));
      if (pick) await select(pick.id, Number.isFinite(at) && opts.readParam('t') !== null ? at : null);
      if (pick && opts.readParam('summary') === '1') setSummary(true);
      // Live traces can appear later (serve --trace-listen); the static export never changes.
      if (source.kind === 'api') {
        setInterval(() => {
          if (!document.hidden) void refreshList();
        }, 3000);
      }
    },
    setTarget(layer) {
      if (layer === target) return;
      target?.clear();
      target = layer;
      layer?.setTip((id, edge) => tipRows(id, edge));
      render();
      if (playing) schedule();
    },
    setSnapshotSha(sha) {
      snapSha = sha;
      syncControls();
    },
    redraw() {
      render();
    },
  };

  function tipRows(id: string, edge?: { from: string; to: string }): Array<[string, string]> {
    const tt = ensureTotals();
    if (!tt) return [];
    if (edge) {
      const n = tt.edges.get(`${edge.from}\n${edge.to}`);
      return n ? [['Runtime calls', fmt(n)]] : [];
    }
    const n = tt.files.get(id);
    return n ? [['Executed', `${fmt(n)} calls`]] : [];
  }
}

/** The live trace that started last, if any. */
function newestLive(list: TraceInfo[]): TraceInfo | undefined {
  return list.filter((x) => x.live).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

/** Total calls per file over the whole trace, as an overlay color mode. */
export function executedOverlay(t: Totals): Overlay {
  return { name: 'executed', unit: 'calls', higherIsBetter: false, min: 0, rows: [...t.files] };
}
