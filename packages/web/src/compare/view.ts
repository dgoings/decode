import type { FileDelta, FileEntry } from '@codeviz/core';
import { WORKTREE, type DataSource, type Snapshot, type SnapshotDiff, type SnapshotIndex } from '../data.ts';
import { buildCompareGraphModel } from '../graph/model.ts';
import type { HideTarget } from '../hidden.ts';
import { createGraphView, type GraphView } from '../graph/view.ts';
import { createTreemap, type Treemap } from '../treemap.ts';
import { deltaFiles, sliceFor } from './model.ts';
import { createCompareToolbar } from './toolbar.ts';

export interface CompareDeps {
  source: DataSource;
  /** Snapshot by sha (the app reuses the one it already holds). */
  snapshot(sha: string): Promise<Snapshot>;
  readParam(key: string): string | null;
  writeParam(key: string, value: string): void;
  /** View-level filter (hidden files) applied to the fetched diff and head before rendering. */
  filter(diff: SnapshotDiff, head: Snapshot): { diff: SnapshotDiff; head: Snapshot };
  /** Right-click on a file or directory (treemap block/header, graph node/compound). */
  onContextMenu(target: HideTarget, ev: MouseEvent): void;
  /** Extra element appended to the summary bar on each render. */
  barExtra(): Node;
}

export interface CompareView {
  readonly el: HTMLElement;
  setIndex(index: SnapshotIndex): void;
  /** Called when the pane becomes visible or the hash changes: (re)load base/head from the hash. */
  show(): void;
  /** Re-apply the filter to the loaded comparison and re-render (no re-fetch). */
  refresh(): void;
}

type Panel = 'treemap' | 'edges';
const PANELS: Array<[Panel, string]> = [
  ['treemap', 'Treemap'],
  ['edges', 'Edges'],
];
/** Anything else (including the retired `changes`) falls back to the treemap. */
const readPanel = (v: string | null): Panel => (v === 'edges' ? v : 'treemap');
const NEUTRAL_FILL = '#e1e4e8';
/** GitHub's diff addition / deletion colors. */
const GROW = '#1f883d';
const SHRINK = '#cf222e';

const fmt = (n: number) => n.toLocaleString();
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0');
const short = (sha: string) => (sha === WORKTREE ? sha : sha.slice(0, 7));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Growth/shrink slice along the block's left edge, plus a border for added/removed/renamed files. */
function sliceOverlay(d: FileDelta | undefined, f: FileEntry, box: { x: number; y: number; w: number; h: number }): SVGElement | null {
  const slice = sliceFor(d, f);
  const renamed = d?.status === 'renamed';
  if (!slice && !renamed) return null;
  const g = svgEl('g', { class: 'cmp-overlay' });
  if (slice) {
    const w = Math.min(box.w, Math.max(2, slice.frac * box.w));
    const red = slice.kind === 'shrink' || slice.kind === 'removed';
    g.append(
      svgEl('rect', {
        class: `cmp-slice cmp-slice-${slice.kind}`,
        'data-frac': slice.frac.toFixed(4),
        x: box.x,
        y: box.y,
        width: w,
        height: box.h,
        fill: red ? SHRINK : GROW,
      }),
    );
  }
  const border = d?.status === 'added' || d?.status === 'removed' || renamed ? d!.status : null;
  if (border && box.w > 2 && box.h > 2) {
    g.append(
      svgEl('rect', {
        class: `cmp-border cmp-border-${border}`,
        x: box.x + 1,
        y: box.y + 1,
        width: box.w - 2,
        height: box.h - 2,
      }),
    );
  }
  return g;
}

function sliceLegend(): HTMLElement {
  const wrap = el('div', 'legend cmp-legend');
  const swatch = (cls: string, label: string) => [el('span', `cmp-swatch ${cls}`), el('span', undefined, label)];
  wrap.append(
    el('span', 'legend-title', 'Δ code lines, as a share of the file'),
    ...swatch('sw-grow', 'added lines'),
    ...swatch('sw-shrink', 'removed lines'),
    ...swatch('sw-added', 'added file'),
    ...swatch('sw-removed', 'removed file'),
  );
  return wrap;
}

export function createCompareView(root: HTMLElement, deps: CompareDeps): CompareView {
  root.classList.add('compare');
  const summary = el('div', 'summary-bar cmp-summary');
  const toolbar = createCompareToolbar({
    source: deps.source,
    readParam: deps.readParam,
    writeParam: deps.writeParam,
    onChange: (base, head) => {
      if (base) deps.writeParam('base', base);
      if (head) deps.writeParam('head', head);
      show();
    },
  });
  const empty = el('p', 'cmp-empty muted', 'Pick a base and a head to compare.');
  const body = el('div', 'cmp-body');
  body.hidden = true;

  // Panel 1: delta treemap.
  const tmPanel = el('section', 'cmp-panel cmp-tm');
  const tmHead = el('div', 'cmp-panel-head');
  const changedLabel = el('label', 'cmp-check');
  const changedOnly = el('input');
  changedOnly.type = 'checkbox';
  changedOnly.name = 'changed-only';
  changedLabel.append(changedOnly, ' Changed only');
  const tmLegend = el('span');
  tmHead.append(el('h3', undefined, 'Delta treemap'), changedLabel, tmLegend);
  const tmBox = el('div');
  tmPanel.append(tmHead, tmBox);

  // Panel 2: head's dependency graph with added / removed edges highlighted.
  const edgePanel = el('section', 'cmp-panel cmp-edges');
  const edgeHead = el('div', 'cmp-panel-head');
  const edgeTitle = el('h3', undefined, 'Dependency graph');
  const edgesChangedLabel = el('label', 'cmp-check');
  const edgesChangedOnly = el('input');
  edgesChangedOnly.type = 'checkbox';
  edgesChangedOnly.name = 'edges-changed-only';
  edgesChangedLabel.append(edgesChangedOnly, ' Changed only');
  const edgeKey = el('span', 'cmp-edge-key');
  edgeKey.append(el('span', 'ek-added'), 'added ', el('span', 'ek-removed'), 'removed ', el('span', 'ek-mixed'), 'both');
  edgeHead.append(edgeTitle, edgesChangedLabel, edgeKey);
  const graphBox = el('div', 'cmp-graph');
  edgePanel.append(edgeHead, graphBox);

  // One panel at a time, picked by the segmented control under the toolbar (hash `panel=`).
  const panelSwitch = el('div', 'segmented cmp-panel-switch');
  panelSwitch.setAttribute('role', 'group');
  panelSwitch.setAttribute('aria-label', 'Panel');
  const panelEls: Record<Panel, HTMLElement> = { treemap: tmPanel, edges: edgePanel };
  const panelButtons = PANELS.map(([name, label]) => {
    const b = el('button', undefined, label);
    b.type = 'button';
    b.dataset.panel = name;
    b.addEventListener('click', () => setPanel(name));
    panelSwitch.append(b);
    return b;
  });
  body.append(panelSwitch, tmPanel, edgePanel);
  root.replaceChildren(summary, toolbar.el, empty, body);

  let index: SnapshotIndex | null = null;
  /** Raw comparison as fetched. */
  let raw: { diff: SnapshotDiff; head: Snapshot } | null = null;
  /** Filtered comparison the panels render. */
  let state: { diff: SnapshotDiff; head: Snapshot; deltas: Map<string, FileDelta> } | null = null;
  let loadedKey: string | null = null;
  let seq = 0;
  let dirty = false;
  let treemap: Treemap | null = null;
  let graph: GraphView | null = null;
  let panel: Panel = readPanel(deps.readParam('panel'));
  /** Graph laid out while hidden (or resized since): fit it the next time Edges is shown. */
  let graphNeedsFit = false;
  let graphSize = '';

  edgesChangedOnly.addEventListener('change', () => graph?.setChangedOnly(edgesChangedOnly.checked));

  changedOnly.addEventListener('change', () => renderTreemap());

  function refLabel(side: { sha: string; ref: string }): string {
    if (side.sha === WORKTREE) return WORKTREE;
    const named = index?.snapshots.find((s) => s.sha === side.sha)?.ref;
    const ref = side.ref && side.ref !== side.sha ? side.ref : named && named !== side.sha ? named : '';
    return /^[0-9a-f]{40}$/.test(ref) || !ref ? short(side.sha) : ref;
  }

  function renderSummary(diff: SnapshotDiff): void {
    const side = (s: { sha: string; ref: string }) => {
      const strong = el('strong', undefined, refLabel(s));
      const code = el('code', undefined, short(s.sha));
      return [strong, code];
    };
    const t = diff.totals;
    const totals = el(
      'span',
      'muted',
      `files +${t.files.added} −${t.files.removed} ~${t.files.modified} renamed ${t.files.renamed} · code ${signed(t.code)} · edges +${t.edges.added} −${t.edges.removed}`,
    );
    summary.replaceChildren(...side(diff.base), el('span', 'muted', '→'), ...side(diff.head), totals, deps.barExtra());
  }

  function tipRows(f: FileEntry): Array<[string, string]> {
    const d = state?.deltas.get(f.path);
    if (!d) return [['Status', 'n/a']];
    const rows: Array<[string, string]> = [['Status', d.oldPath ? `${d.status} from ${d.oldPath}` : d.status]];
    const now = d.status === 'removed' ? 0 : (f.code ?? 0);
    rows.push(['Code', `${fmt(now)} lines (${signed(d.code)})`]);
    const slice = sliceFor(d, f);
    if (slice && d.code !== 0) {
      const pct = `${Math.round(slice.frac * 100)}% of ${slice.kind === 'grow' || slice.kind === 'added' ? 'file' : 'base file'}`;
      rows.push(['Change', `${d.code > 0 ? '+' : '−'}${fmt(Math.abs(d.code))} lines (${pct})`]);
    }
    rows.push(['Loc', signed(d.loc)]);
    rows.push(['Complexity', `${signed(d.complexitySum)} sum / ${signed(d.complexityMax)} max`]);
    rows.push(['Churn', `${signed(d.churnCommits)} commits`]);
    return rows;
  }

  function renderTreemap(): void {
    if (!state) return;
    const { diff, head } = state;
    if (!tmLegend.firstChild) tmLegend.replaceChildren(sliceLegend());
    if (!treemap) {
      treemap = createTreemap(tmBox, {
        onContextMenu: deps.onContextMenu,
        style: {
          fill: (f) => (state?.deltas.get(f.path)?.status === 'removed' ? 'url(#tm-removed)' : NEUTRAL_FILL),
          className: (f) => {
            const s = state?.deltas.get(f.path)?.status;
            return s === 'added' || s === 'removed' || s === 'renamed' ? `cmp-${s}` : undefined;
          },
          overlay: (f, box) => sliceOverlay(state?.deltas.get(f.path), f, box),
          tipRows,
        },
      });
    }
    treemap.render({ ...head, files: deltaFiles(head.files, diff, changedOnly.checked) }, 'complexity');
  }
  function renderEdges(): void {
    if (!state) return;
    const { diff, head } = state;
    edgeTitle.textContent = `Dependency graph · +${fmt(diff.edges.added.length)} / −${fmt(diff.edges.removed.length)} edges`;
    if (!graph) graph = createGraphView(graphBox, { onContextMenu: deps.onContextMenu });
    graph.render(head, buildCompareGraphModel(head, diff));
    graph.setChangedOnly(edgesChangedOnly.checked);
    graphNeedsFit = true;
    if (panel === 'edges') refitGraph();
  }

  /** Cytoscape cannot size itself while display:none; resize and re-fit once its box is visible. */
  function refitGraph(): void {
    if (!graph || graphBox.hidden) return;
    const { width, height } = graphBox.getBoundingClientRect();
    if (width < 10 || height < 10) return;
    const size = `${Math.round(width)}x${Math.round(height)}`;
    graph.resize(graphNeedsFit || size !== graphSize);
    graphNeedsFit = false;
    graphSize = size;
  }

  function applyPanel(): void {
    for (const b of panelButtons) b.setAttribute('aria-pressed', String(b.dataset.panel === panel));
    for (const [name, p] of Object.entries(panelEls)) p.hidden = name !== panel;
    root.dataset.panel = panel;
    // The treemap redraws from its own ResizeObserver (0x0 -> visible); the graph needs an explicit fit.
    if (panel === 'edges') refitGraph();
  }

  function setPanel(next: Panel): void {
    deps.writeParam('panel', next);
    if (next === panel) return;
    panel = next;
    applyPanel();
  }
  applyPanel();

  function renderAll(): void {
    if (!raw) return;
    if (root.hidden) {
      dirty = true;
      return;
    }
    dirty = false;
    const { diff, head } = deps.filter(raw.diff, raw.head);
    state = { diff, head, deltas: new Map(diff.files.map((d) => [d.path, d])) };
    renderSummary(state.diff);
    renderTreemap();
    renderEdges();
  }

  async function load(base: string, head: string): Promise<void> {
    const key = `${base}\n${head}`;
    if (key === loadedKey) return;
    loadedKey = key;
    const my = ++seq;
    const t0 = performance.now();
    toolbar.setStatus(`Comparing ${short(base)} → ${short(head)}…`, 'busy');
    try {
      if (!deps.source.compare) throw new Error('compare is not available for this data source');
      const diff = await deps.source.compare(base, head);
      const headSnap = await deps.snapshot(diff.head.sha);
      if (my !== seq) return;
      raw = { diff, head: headSnap };
      empty.hidden = true;
      body.hidden = false;
      renderAll();
      root.dataset.compareMs = (performance.now() - t0).toFixed(0);
      toolbar.setStatus(`Compared in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      if (my !== seq) return;
      loadedKey = null;
      raw = null;
      state = null;
      body.hidden = true;
      empty.hidden = false;
      empty.textContent = 'Comparison failed.';
      summary.replaceChildren();
      toolbar.setStatus(`Could not compare: ${(err as Error).message}`, 'error');
    }
  }

  function show(): void {
    const nextPanel = readPanel(deps.readParam('panel'));
    if (nextPanel !== panel) {
      panel = nextPanel;
      applyPanel();
    }
    const base = deps.readParam('base');
    const head = deps.readParam('head');
    toolbar.setValue(base, head);
    if (!base || !head) {
      seq++;
      loadedKey = null;
      raw = null;
      state = null;
      body.hidden = true;
      empty.hidden = false;
      empty.textContent = 'Pick a base and a head to compare.';
      summary.replaceChildren(el('strong', undefined, 'Compare'), el('span', 'muted', 'two analyzed refs'));
      toolbar.setStatus('');
      return;
    }
    if (`${base}\n${head}` !== loadedKey) void load(base, head);
    else if (dirty) renderAll();
  }

  return {
    el: root,
    setIndex(next) {
      index = next;
      toolbar.setIndex(next);
    },
    show,
    refresh: renderAll,
  };
}
