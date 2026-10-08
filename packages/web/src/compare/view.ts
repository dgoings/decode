import type { Core, EdgeSingular } from 'cytoscape';
import type { FileDelta, FileEntry } from '@codeviz/core';
import { WORKTREE, type DataSource, type Snapshot, type SnapshotDiff, type SnapshotIndex } from '../data.ts';
import { ancestors, buildGraphModel, type GraphModel } from '../graph/model.ts';
import { createGraphView, type GraphView } from '../graph/view.ts';
import { createTreemap, type Treemap } from '../treemap.ts';
import { deltaFiles, edgeSnapshot, sliceFor, type EdgeFilter } from './model.ts';
import { createCompareToolbar } from './toolbar.ts';

export interface CompareDeps {
  source: DataSource;
  /** Snapshot by sha (the app reuses the one it already holds). */
  snapshot(sha: string): Promise<Snapshot>;
  readParam(key: string): string | null;
  writeParam(key: string, value: string): void;
}

export interface CompareView {
  readonly el: HTMLElement;
  setIndex(index: SnapshotIndex): void;
  /** Called when the pane becomes visible or the hash changes: (re)load base/head from the hash. */
  show(): void;
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
const ADDED_EDGE = '#15803d';
const REMOVED_EDGE = '#d92d20';

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
  const toolbar = createCompareToolbar((base, head) => {
    if (base) deps.writeParam('base', base);
    if (head) deps.writeParam('head', head);
    show();
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

  // Panel 2: edge changes.
  const edgePanel = el('section', 'cmp-panel cmp-edges');
  const edgeHead = el('div', 'cmp-panel-head');
  const edgeTitle = el('h3', undefined, 'Edge changes');
  const edgeFilter = el('div', 'segmented');
  edgeFilter.setAttribute('role', 'group');
  edgeFilter.setAttribute('aria-label', 'Edges');
  const edgeKey = el('span', 'cmp-edge-key');
  edgeKey.append(el('span', 'ek-added'), 'added ', el('span', 'ek-removed'), 'removed');
  edgeHead.append(edgeTitle, edgeKey, edgeFilter);
  const graphBox = el('div', 'cmp-graph');
  const edgeEmpty = el('p', 'muted cmp-empty', 'No dependency edges changed.');
  edgeEmpty.hidden = true;
  edgePanel.append(edgeHead, graphBox, edgeEmpty);

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
  let state: { diff: SnapshotDiff; head: Snapshot; deltas: Map<string, FileDelta> } | null = null;
  let loadedKey: string | null = null;
  let seq = 0;
  let dirty = false;
  let filter: EdgeFilter = 'all';
  let treemap: Treemap | null = null;
  let graph: GraphView | null = null;
  let graphModel: GraphModel | null = null;
  let changedEdges: Array<{ from: string; to: string; kind: string }> = [];
  let panel: Panel = readPanel(deps.readParam('panel'));
  /** Graph laid out while hidden (or resized since): fit it the next time Edges is shown. */
  let graphNeedsFit = false;
  let graphSize = '';

  const filterButtons = (
    [
      ['all', 'All'],
      ['added', 'Added'],
      ['removed', 'Removed'],
    ] as const
  ).map(([name, label]) => {
    const b = el('button', undefined, label);
    b.type = 'button';
    b.dataset.filter = name;
    b.setAttribute('aria-pressed', String(name === filter));
    b.addEventListener('click', () => {
      if (filter === name) return;
      filter = name;
      for (const x of filterButtons) x.setAttribute('aria-pressed', String(x.dataset.filter === name));
      renderEdges();
    });
    edgeFilter.append(b);
    return b;
  });

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
    summary.replaceChildren(...side(diff.base), el('span', 'muted', '→'), ...side(diff.head), totals);
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
  /** Color changed edges through the graph view's Cytoscape instance (graph/ has no kind hook). */
  function hookEdgeStyling(): void {
    const cy = graphCy();
    if (!cy) {
      graphBox.dataset.edgeStyling = 'none';
      return;
    }
    graphBox.dataset.edgeStyling = 'cy';
    cy.style()
      .selector('edge[change = "added"]')
      .style({ 'line-color': ADDED_EDGE, 'target-arrow-color': ADDED_EDGE, width: 2.5, opacity: 1 })
      .selector('edge[change = "removed"]')
      .style({ 'line-color': REMOVED_EDGE, 'target-arrow-color': REMOVED_EDGE, 'line-style': 'dashed', width: 2.5, opacity: 1 })
      .selector('edge[change = "mixed"]')
      .style({ 'line-color': '#8a5a00', 'target-arrow-color': '#8a5a00', 'line-style': 'dotted', width: 2.5 })
      .update();
    const under = (vis: string, id: string) => vis === id || (graphModel ? ancestors(graphModel, id).includes(vis) : false);
    cy.on('add', 'edge', (e) => {
      const edge = e.target as EdgeSingular;
      const s = edge.source().id();
      const t = edge.target().id();
      const kinds = new Set(changedEdges.filter((c) => under(s, c.from) && under(t, c.to)).map((c) => c.kind));
      edge.data('change', kinds.size === 1 ? [...kinds][0] : kinds.size ? 'mixed' : undefined);
    });
  }

  function renderEdges(): void {
    if (!state) return;
    const { diff, head } = state;
    const added = diff.edges.added.length;
    const removed = diff.edges.removed.length;
    edgeTitle.textContent = `Edge changes · +${fmt(added)} / −${fmt(removed)}`;
    const snap = edgeSnapshot(diff, head, filter);
    graphBox.dataset.edges = filter;
    changedEdges = snap.edges;
    const none = snap.edges.length === 0;
    edgeEmpty.hidden = !none;
    graphBox.hidden = none;
    if (none) {
      edgeEmpty.textContent = added + removed ? `No ${filter} edges.` : 'No dependency edges changed.';
      return;
    }
    graphModel = buildGraphModel(snap);
    if (!graph) {
      graph = createGraphView(graphBox);
      hookEdgeStyling();
    }
    graph.render(snap);
    graphNeedsFit = true;
    if (panel === 'edges') refitGraph();
  }

  function graphCy(): Core | undefined {
    return (graphBox.querySelector('.graph-cy') as (HTMLElement & { _cyreg?: { cy?: Core } }) | null)?._cyreg?.cy;
  }

  /** Cytoscape cannot size itself while display:none; resize and re-fit once its box is visible. */
  function refitGraph(): void {
    const cy = graphCy();
    if (!cy || graphBox.hidden) return;
    const { width, height } = graphBox.getBoundingClientRect();
    if (width < 10 || height < 10) return;
    const size = `${Math.round(width)}x${Math.round(height)}`;
    cy.resize();
    if (graphNeedsFit || size !== graphSize) cy.fit(undefined, 30);
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
    if (!state) return;
    if (root.hidden) {
      dirty = true;
      return;
    }
    dirty = false;
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
      state = { diff, head: headSnap, deltas: new Map(diff.files.map((d) => [d.path, d])) };
      empty.hidden = true;
      body.hidden = false;
      renderAll();
      root.dataset.compareMs = (performance.now() - t0).toFixed(0);
      toolbar.setStatus(`Compared in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      if (my !== seq) return;
      loadedKey = null;
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
  };
}
