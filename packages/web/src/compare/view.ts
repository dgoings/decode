import type { FileDelta, FileEntry } from '@codeviz/core';
import { WORKTREE, type DataSource, type Snapshot, type SnapshotDiff, type SnapshotIndex } from '../data.ts';
import { scaleLinear } from 'd3-scale';
import { interpolateRdBu } from 'd3-scale-chromatic';
import { buildCompareGraphModel } from '../graph/model.ts';
import { createGraphView, type GraphView } from '../graph/view.ts';
import { createTreemap, type Treemap } from '../treemap.ts';
import {
  changedRows,
  compareDeltas,
  deltaFiles,
  DEFAULT_SORT,
  type SortKey,
  type SortSpec,
} from './model.ts';
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

const MAX_ROWS = 200;
type Panel = 'treemap' | 'edges' | 'changes';
const PANELS: Array<[Panel, string]> = [
  ['treemap', 'Treemap'],
  ['edges', 'Edges'],
  ['changes', 'Changes'],
];
const readPanel = (v: string | null): Panel => (v === 'edges' || v === 'changes' ? v : 'treemap');
const UNCHANGED_FILL = '#d5d8dd';

const fmt = (n: number) => n.toLocaleString();
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0');
const short = (sha: string) => (sha === WORKTREE ? sha : sha.slice(0, 7));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Diverging color on Δcode: blues shrink, reds grow; symmetric domain at the 95th percentile of |Δ|. */
export function deltaScale(diff: SnapshotDiff): { hi: number; max: number; color(d: FileDelta | undefined): string } {
  const abs = diff.files
    .filter((d) => d.status !== 'unchanged')
    .map((d) => Math.abs(d.code))
    .sort((a, b) => a - b);
  const p95 = abs.length ? abs[Math.floor(0.95 * (abs.length - 1))]! : 1;
  const hi = Math.max(1, scaleLinear().domain([0, p95]).nice().domain()[1]!);
  const at = (v: number) => {
    if (v === 0) return interpolateRdBu(0.5);
    const t = Math.min(1, Math.abs(v) / hi);
    // Start a little off-centre so small changes are still tinted.
    return interpolateRdBu(0.5 - Math.sign(v) * (0.1 + 0.4 * t));
  };
  return {
    hi,
    max: abs.length ? abs[abs.length - 1]! : 0,
    color: (d) => (!d || d.status === 'unchanged' ? UNCHANGED_FILL : at(d.code)),
  };
}

function deltaLegend(scale: ReturnType<typeof deltaScale>): HTMLElement {
  const wrap = el('div', 'legend');
  const bar = el('span', 'legend-bar');
  const stops = Array.from({ length: 9 }, (_, i) => {
    const v = scale.hi * (i / 4 - 1);
    return scale.color({ status: 'modified', code: v } as FileDelta);
  });
  bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  const clamped = scale.max > scale.hi;
  const lo = el('span', undefined, `${clamped ? '≤' : ''}−${fmt(scale.hi)}`);
  const hi = el('span', undefined, `${clamped ? '≥' : ''}+${fmt(scale.hi)}`);
  if (clamped) lo.title = hi.title = `Clamped at the 95th percentile; largest change is ${fmt(scale.max)} lines`;
  const swatch = (cls: string, label: string) => {
    const s = el('span', `cmp-swatch ${cls}`);
    return [s, el('span', undefined, label)];
  };
  wrap.append(
    el('span', 'legend-title', 'Δ code lines'),
    lo,
    bar,
    hi,
    ...swatch('sw-unchanged', 'unchanged'),
    ...swatch('sw-added', 'added'),
    ...swatch('sw-removed', 'removed'),
  );
  return wrap;
}

const COLUMNS: Array<[SortKey, string]> = [
  ['path', 'Path'],
  ['status', 'Status'],
  ['code', 'Δ code'],
  ['loc', 'Δ loc'],
  ['complexitySum', 'Δ cx sum'],
  ['complexityMax', 'Δ cx max'],
  ['churnCommits', 'Δ churn'],
];

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

  // Panel 3: biggest changes.
  const tablePanel = el('section', 'cmp-panel cmp-table');
  const tableHead = el('div', 'cmp-panel-head');
  const tableNote = el('span', 'muted');
  tableHead.append(el('h3', undefined, 'Biggest changes'), tableNote);
  const tableWrap = el('div', 'cmp-table-wrap');
  const table = el('table');
  const thead = el('thead');
  const tbody = el('tbody');
  table.append(thead, tbody);
  tableWrap.append(table);
  tablePanel.append(tableHead, tableWrap);

  // One panel at a time, picked by the segmented control under the toolbar (hash `panel=`).
  const panelSwitch = el('div', 'segmented cmp-panel-switch');
  panelSwitch.setAttribute('role', 'group');
  panelSwitch.setAttribute('aria-label', 'Panel');
  const panelEls: Record<Panel, HTMLElement> = { treemap: tmPanel, edges: edgePanel, changes: tablePanel };
  const panelButtons = PANELS.map(([name, label]) => {
    const b = el('button', undefined, label);
    b.type = 'button';
    b.dataset.panel = name;
    b.addEventListener('click', () => setPanel(name));
    panelSwitch.append(b);
    return b;
  });
  body.append(panelSwitch, tmPanel, edgePanel, tablePanel);
  root.replaceChildren(summary, toolbar.el, empty, body);

  let index: SnapshotIndex | null = null;
  let state: { diff: SnapshotDiff; head: Snapshot; deltas: Map<string, FileDelta> } | null = null;
  let loadedKey: string | null = null;
  let seq = 0;
  let dirty = false;
  let sort: SortSpec = DEFAULT_SORT;
  let selected: string | null = null;
  let treemap: Treemap | null = null;
  let graph: GraphView | null = null;
  let currentScale: ReturnType<typeof deltaScale> | null = null;
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
    summary.replaceChildren(...side(diff.base), el('span', 'muted', '→'), ...side(diff.head), totals);
  }

  function tipRows(f: FileEntry): Array<[string, string]> {
    const d = state?.deltas.get(f.path);
    if (!d) return [['Status', 'n/a']];
    const rows: Array<[string, string]> = [['Status', d.oldPath ? `${d.status} from ${d.oldPath}` : d.status]];
    const now = d.status === 'removed' ? 0 : (f.code ?? 0);
    rows.push(['Code', `${fmt(now)} lines (${signed(d.code)})`]);
    rows.push(['Loc', signed(d.loc)]);
    rows.push(['Complexity', `${signed(d.complexitySum)} sum / ${signed(d.complexityMax)} max`]);
    rows.push(['Churn', `${signed(d.churnCommits)} commits`]);
    return rows;
  }

  function renderTreemap(): void {
    if (!state) return;
    const { diff, head, deltas } = state;
    const scale = deltaScale(diff);
    tmLegend.replaceChildren(deltaLegend(scale));
    if (!treemap) {
      treemap = createTreemap(tmBox, {
        onFileClick: (path) => selectRow(path, false),
        style: {
          fill: (f) => currentScale!.color(state?.deltas.get(f.path)),
          className: (f) => {
            const s = state?.deltas.get(f.path)?.status;
            return s === 'added' || s === 'removed' ? `cmp-${s}` : undefined;
          },
          tipRows,
        },
      });
    }
    currentScale = scale;
    treemap.render({ ...head, files: deltaFiles(head.files, diff, changedOnly.checked) }, 'complexity');
    if (selected && deltas.has(selected)) treemap.reveal(selected);
  }
  function renderEdges(): void {
    if (!state) return;
    const { diff, head } = state;
    edgeTitle.textContent = `Dependency graph · +${fmt(diff.edges.added.length)} / −${fmt(diff.edges.removed.length)} edges`;
    if (!graph) graph = createGraphView(graphBox);
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

  function renderTable(): void {
    if (!state) return;
    const rows = changedRows(state.diff, sort);
    tableNote.textContent =
      rows.length > MAX_ROWS ? `Showing ${MAX_ROWS} of ${fmt(rows.length)} changed files` : `${fmt(rows.length)} changed files`;
    const tr = el('tr');
    for (const [key, label] of COLUMNS) {
      const th = el('th');
      const b = el('button', undefined, label + (sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''));
      b.type = 'button';
      b.dataset.sort = key;
      b.addEventListener('click', () => {
        sort = sort.key === key ? { key, desc: !sort.desc } : { key, desc: key !== 'path' && key !== 'status' };
        renderTable();
      });
      th.append(b);
      if (key !== 'path' && key !== 'status') th.className = 'num';
      tr.append(th);
    }
    thead.replaceChildren(tr);
    tbody.replaceChildren(
      ...rows.slice(0, MAX_ROWS).map((d) => {
        const row = el('tr');
        row.dataset.path = d.path;
        if (d.path === selected) row.classList.add('selected');
        const path = el('td', 'cmp-path', d.path);
        if (d.oldPath) path.title = `renamed from ${d.oldPath}`;
        row.append(path, el('td', `cmp-st st-${d.status}`, d.status));
        for (const k of ['code', 'loc', 'complexitySum', 'complexityMax', 'churnCommits'] as const) {
          const v = d[k];
          row.append(el('td', `num${v > 0 ? ' up' : v < 0 ? ' down' : ''}`, signed(v)));
        }
        row.addEventListener('click', () => selectRow(d.path, true));
        return row;
      }),
    );
  }

  function selectRow(path: string, fromTable: boolean): void {
    selected = path;
    for (const r of tbody.querySelectorAll<HTMLElement>('tr')) r.classList.toggle('selected', r.dataset.path === path);
    if (fromTable) {
      setPanel('treemap');
      treemap?.reveal(path);
    } else {
      tbody.querySelector<HTMLElement>(`tr[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

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
    renderTable();
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
      selected = null;
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
