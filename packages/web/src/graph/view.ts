import cytoscape, { type Core, type ElementDefinition, type NodeSingular, type EdgeSingular, type Position } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Snapshot } from '../data.ts';
import type { HideTarget } from '../hidden.ts';
import { tierBadges } from '../refpicker.ts';
import { colorScale, metric, overlayTipRows, type ColorMode, type ColorScale } from '../treemap.ts';
import type { FileEntry } from '@codeviz/core';
import { boxSize } from './boxes.ts';
import {
  aggregateEdges,
  ancestors,
  buildGraphModel,
  cyclePath,
  findCycles,
  groupsBelow,
  isOpaqueKind,
  type Cycles,
  type GraphModel,
  type VisibleGraph,
} from './model.ts';

cytoscape.use(fcose);

export interface GraphView {
  readonly el: HTMLElement;
  /** Draw `snap`; pass `model` to draw a prebuilt one instead (e.g. buildCompareGraphModel). */
  render(snap: Snapshot, model?: GraphModel): void;
  /** Hide unchanged edges and nodes without a visible changed edge (compare mode). */
  setChangedOnly(on: boolean): void;
  /** Re-measure the container (after it was hidden or resized); `fit` also fits the view. */
  resize(fit: boolean): void;
  /** Recolor file boxes (or file dots, when created with a colorMode); `force` recolors an unchanged mode (overlay data changed). */
  setColorMode(mode: ColorMode, force?: boolean): void;
  /** Hide or show all edges without moving any node. */
  setShowEdges(on: boolean): void;
  /** For overlays (the trace player). Edges with class `rt` are theirs, and they are left out of layout. */
  readonly cy: Core;
  model(): GraphModel | null;
  visible(): VisibleGraph | null;
  /** Called after the drawn elements were rebuilt (render, expand/collapse); returns an unsubscribe. */
  onElements(fn: () => void): () => void;
  /** False while edges are hidden (map view's Show edges). */
  edgesShown(): boolean;
  /** The element that holds the Cytoscape canvas (an overlay canvas can be stacked on it). */
  readonly stage: HTMLElement;
  /** Extra tooltip rows for a node id or an edge (from/to are visible node ids). */
  setTipExtra(fn: ((id: string, edge?: { from: string; to: string }) => Array<[string, string]>) | null): void;
  destroy(): void;
}

// GitHub diff colors.
const ADDED = '#1f883d';
const REMOVED = '#cf222e';
/** Trace player: executed nodes and import edges carrying calls; runtime edges with no import edge. */
const HOT = '#f97316';
const RUNTIME = '#7c3aed';

const fmt = (n: number) => n.toLocaleString();
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;

const STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'font-size': 12,
      color: '#1d2025',
      'text-valign': 'bottom',
      'text-margin-y': 3,
      width: 14,
      height: 14,
      'background-color': '#5b8def',
      'min-zoomed-font-size': 7,
    },
  },
  {
    selector: 'node[type = "group"]',
    style: {
      shape: 'round-rectangle',
      width: 'data(size)',
      height: 'data(size)',
      'background-color': '#dfe3ea',
      'border-width': 1,
      'border-color': '#9aa1ab',
      'font-size': 13,
      'font-weight': 600,
    },
  },
  {
    selector: ':parent',
    style: {
      'background-color': '#f3f4f6',
      'background-opacity': 0.55,
      'border-color': '#c9ccd2',
      'text-valign': 'top',
      'text-halign': 'left-inside',
      'text-margin-y': -2,
      padding: '14px',
      'font-size': 14,
    },
  },
  {
    selector: 'edge',
    style: {
      width: 'mapData(count, 1, 30, 1, 6)',
      'line-color': '#b8bec8',
      'target-arrow-color': '#b8bec8',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'straight',
      opacity: 0.85,
    },
  },
  {
    selector: 'edge[cycleCount > 0]',
    style: {
      width: 'mapData(count, 1, 30, 2.5, 8)',
      'line-color': '#d92d20',
      'target-arrow-color': '#d92d20',
      'z-index': 10,
      opacity: 1,
    },
  },
  {
    // Opaque modules (Go packages, namespaces, crates): rounded boxes sized by file count.
    selector: 'node[?opaque]',
    style: {
      shape: 'round-rectangle',
      width: 'data(size)',
      height: 'data(size)',
      'background-color': '#c8ece4',
      'border-width': 1.5,
      'border-color': '#2a9d8f',
      color: '#134e48',
    },
  },
  {
    selector: ':parent[?opaque]',
    style: { 'background-color': '#eaf7f4', 'background-opacity': 0.6, 'border-color': '#7cc4b8' },
  },
  { selector: 'edge[level = "module"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 3] } },
  // Compare mode. A changed edge in a cycle keeps the change color but the cycle width.
  {
    selector: 'edge[change = "added"]',
    style: { 'line-color': ADDED, 'target-arrow-color': ADDED, width: 'mapData(count, 1, 30, 2, 7)', 'z-index': 20, opacity: 1 },
  },
  {
    selector: 'edge[change = "removed"]',
    style: {
      'line-color': REMOVED,
      'target-arrow-color': REMOVED,
      'line-style': 'dashed',
      'line-dash-pattern': [6, 3],
      width: 'mapData(count, 1, 30, 2, 7)',
      'z-index': 20,
      opacity: 1,
    },
  },
  {
    // Dashed green over a solid red underlay of the same width: the gaps show red.
    selector: 'edge[change = "mixed"]',
    style: {
      'line-color': ADDED,
      'target-arrow-color': ADDED,
      'line-style': 'dashed',
      'line-dash-pattern': [6, 4],
      width: 'mapData(count, 1, 30, 2.5, 7)',
      'underlay-color': REMOVED,
      'underlay-opacity': 1,
      'underlay-padding': 'mapData(count, 1, 30, 1.25, 3.5)',
      'z-index': 20,
      opacity: 1,
    },
  },
  { selector: 'edge[change][cycleCount > 0]', style: { width: 'mapData(count, 1, 30, 2.5, 8)' } },
  { selector: 'edge[change = "mixed"][cycleCount > 0]', style: { 'underlay-padding': 'mapData(count, 1, 30, 1.25, 4)' } },
  {
    selector: 'node[?ghost]',
    style: {
      'background-color': '#ffffff',
      'background-opacity': 0.6,
      'border-width': 1.5,
      'border-style': 'dashed',
      'border-color': '#8c959f',
      color: '#8c959f',
      'font-style': 'italic',
    },
  },
  { selector: '.unchanged-hidden', style: { display: 'none' } },
  // File dots colored by the active metric (graph view only; set when created with a colorMode).
  { selector: 'node[dot]', style: { 'background-color': 'data(dot)' } },
  { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#2f6fdb' } },
  { selector: 'edge:selected', style: { 'line-color': '#2f6fdb', 'target-arrow-color': '#2f6fdb' } },
  { selector: 'edge.edges-off', style: { display: 'none' } },
  // Trace player summary (trace/layer.ts): lit nodes get an underlay-opacity bypass, so the underlay
  // is always there at opacity 0. Playback draws on an overlay canvas instead and never restyles.
  {
    selector: 'node',
    style: { 'underlay-color': HOT, 'underlay-opacity': 0, 'underlay-padding': 6, 'underlay-shape': 'ellipse' },
  },
  { selector: 'edge.tr-called', style: { 'line-style': 'solid' } },
  { selector: 'edge.tr-uncalled', style: { opacity: 0.18 } },
  {
    selector: 'edge.rt',
    style: {
      display: 'none',
      'line-color': RUNTIME,
      'target-arrow-color': RUNTIME,
      'line-style': 'dashed',
      'line-dash-pattern': [4, 4],
      'curve-style': 'unbundled-bezier',
      'control-point-distances': [40],
      'control-point-weights': [0.5],
      width: 2,
      opacity: 1,
      'z-index': 31,
    },
  },
  { selector: 'edge.rt.edges-off', style: { display: 'none' } },
];

/** Boxes mode (map view): files and collapsed folders as sized, colored rectangles with the label inside. */
const BOX_STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node[?box]',
    style: {
      shape: 'rectangle',
      width: 'data(w)',
      height: 'data(h)',
      'background-color': 'data(bg)',
      'border-width': 1,
      'border-color': '#ffffff',
      label: 'data(boxLabel)',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-margin-y': 0,
      'text-wrap': 'ellipsis',
      'text-max-width': 'data(tmw)',
      'font-size': 11,
      color: 'data(fg)',
    },
  },
  { selector: 'node[?box][type = "group"]', style: { 'border-color': '#9aa1ab', 'font-size': 13 } },
  { selector: 'node[?box]:selected', style: { 'border-width': 3, 'border-color': '#2f6fdb' } },
  { selector: 'node[?box]', style: { 'underlay-shape': 'round-rectangle' } },
];

/** Neutral grey for files without the active metric (the treemap's hatched n/a fill does not exist here). */
const NA_BOX = '#e3e5e9';
/** Same for dots, a step darker so a small dot still reads on the white canvas. */
const NA_DOT = '#b8bec8';
const BOX_FOLDER_MAX = 320;
const fmtOr = (v: number | undefined) => (v === undefined ? 'n/a' : String(v));

/** Dark text on light fills, white on dark ones. */
function textOn(bg: string): string {
  const m = /^rgb\((\d+), ?(\d+), ?(\d+)\)$/.exec(bg);
  if (!m) return '#1d2025';
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? '#ffffff' : '#1d2025';
}

/** Dependency graph: directories as collapsible compound nodes, cycle edges in red, cycle list on the side. */
export interface GraphViewOptions {
  /** Right-click on a file node or a directory compound (not package modules or ghosts). */
  onContextMenu?(target: HideTarget, ev: MouseEvent): void;
  /** Extra element appended to the summary bar on each render. */
  barExtra?(): Node;
  /** 'boxes' (map view): files and collapsed folders drawn as rectangles sized by code. Default 'dots'. */
  mode?: 'dots' | 'boxes';
  /** Initial color metric for file boxes; in dots mode, setting it colors file dots too. */
  colorMode?: ColorMode;
  /** Initial edge visibility (default true). */
  showEdges?: boolean;
}

export function createGraphView(container: HTMLElement, opts: GraphViewOptions = {}): GraphView {
  container.classList.add('graph');
  const bar = document.createElement('div');
  bar.className = 'summary-bar';
  const stage = document.createElement('div');
  stage.className = 'graph-stage';
  const cyBox = document.createElement('div');
  cyBox.className = 'graph-cy';
  const empty = document.createElement('p');
  empty.className = 'graph-empty muted';
  empty.hidden = true;
  const tip = document.createElement('div');
  tip.className = 'tm-tip';
  tip.hidden = true;
  stage.append(cyBox, empty, tip);
  const side = document.createElement('aside');
  side.className = 'graph-side';
  const row = document.createElement('div');
  row.className = 'graph-row';
  row.append(stage, side);
  container.replaceChildren(bar, row);

  const boxes = opts.mode === 'boxes';
  const colored = boxes || opts.colorMode !== undefined;
  const cy: Core = cytoscape({
    container: cyBox,
    style: boxes ? [...STYLE, ...BOX_STYLE] : STYLE,
    minZoom: 0.05,
    maxZoom: 4,
    boxSelectionEnabled: false,
  });

  let snap: Snapshot | null = null;
  let model: GraphModel | null = null;
  let cycles: Cycles = { components: [], edgeKeys: new Set() };
  let collapsed = new Set<string>();
  let visible: VisibleGraph | null = null;
  let counts: HTMLElement | null = null;
  let toggleAll: HTMLButtonElement | null = null;
  let changedOnly = false;
  let colorMode: ColorMode = opts.colorMode ?? 'complexity';
  let showEdges = opts.showEdges ?? true;
  let scale: ColorScale | null = null;
  let filesByPath = new Map<string, FileEntry>();
  const elementListeners = new Set<() => void>();
  let tipExtra: ((id: string, edge?: { from: string; to: string }) => Array<[string, string]>) | null = null;
  const notifyElements = () => {
    for (const fn of elementListeners) fn();
  };

  function nodeData(n: VisibleGraph['nodes'][number]): Record<string, unknown> {
    const group = n.type === 'group';
    const hasKids = group && !n.collapsed;
    return {
      id: n.id,
      parent: n.parent ?? undefined,
      type: n.type,
      kind: n.kind,
      opaque: isOpaqueKind(n.kind),
      ghost: n.ghost ?? false,
      label: group ? `${hasKids ? '▾' : '▸'} ${n.label}` : n.label,
      size: group || isOpaqueKind(n.kind) ? Math.round(22 + 5 * Math.sqrt(n.fileCount ?? 0)) : 14,
      ...(boxes ? boxData(n, hasKids) : colored && n.type === 'leaf' && n.kind === 'file' ? { dot: fileColor(n.id) } : {}),
    };
  }

  /** Box geometry and colors; expanded groups are compounds and must not keep a collapsed box's data. */
  function boxData(n: VisibleGraph['nodes'][number], hasKids: boolean): Record<string, unknown> {
    if (hasKids) return { box: false };
    const file = n.type === 'leaf' && n.kind === 'file';
    const { w, h } = file ? boxSize(n.metrics?.code ?? 0) : boxSize(n.code ?? 0, BOX_FOLDER_MAX);
    const bg = file ? fileColor(n.id) : isOpaqueKind(n.kind) ? '#c8ece4' : '#dfe3ea';
    const label = n.type === 'group' ? `▸ ${n.label}` : n.label;
    return { box: true, w, h, bg, fg: textOn(bg), tmw: Math.max(1, w - 6), boxLabel: w < 40 ? '' : label };
  }

  function fileColor(path: string): string {
    const f = filesByPath.get(path);
    const v = f ? metric(f, colorMode) : undefined;
    return v === undefined || !scale ? (boxes ? NA_BOX : NA_DOT) : scale.color(v);
  }

  /** Lay out the shown elements only (fcose throws on display:none nodes hidden by Changed only). */
  function runLayout(fixed: NodeSingular[] = []): number {
    const t = performance.now();
    const incremental = fixed.length > 0;
    cy.elements()
      .not('.unchanged-hidden, .edges-off, .rt')
      .layout({
        name: 'fcose',
        animate: false,
        randomize: !incremental,
        quality: incremental ? 'proof' : 'default',
        nodeDimensionsIncludeLabels: !boxes,
        idealEdgeLength: boxes ? 120 : 70,
        nodeRepulsion: boxes ? 40000 : 6500,
        nestingFactor: 0.4,
        packComponents: boxes,
        // Boxes: stronger (compound) gravity, else fcose spreads loosely connected folders over ~10k px.
        ...(boxes ? { gravity: 1, gravityCompound: 3, gravityRangeCompound: 0.8 } : {}),
        fixedNodeConstraint: incremental
          ? fixed.map((n) => ({ nodeId: n.id(), position: { ...n.position() } }))
          : undefined,
      } as cytoscape.LayoutOptions)
      .run();
    return performance.now() - t;
  }

  /**
   * Sync cy elements with the visible graph in place. Nodes that stay keep their positions; newly
   * revealed nodes start at their nearest previously drawn ancestor and are laid out with
   * everything else pinned (skipped for the initial render, which lays out the whole graph).
   */
  function update(incremental = true): void {
    if (!model) return;
    visible = aggregateEdges(model, collapsed, cycles);
    const want = new Map(visible.nodes.map((n) => [n.id, n]));
    const before = new Map<string, Position>();
    cy.nodes().forEach((n) => void before.set(n.id(), { ...n.position() }));
    const added: ElementDefinition[] = [];
    cy.batch(() => {
      cy.edges().remove();
      cy.nodes().filter((n) => !want.has(n.id())).remove();
      for (const n of visible!.nodes) {
        const data = nodeData(n);
        const el = cy.getElementById(n.id);
        if (el.nonempty()) {
          el.data(data);
          continue;
        }
        const def: ElementDefinition = { group: 'nodes', data: data as ElementDefinition['data'] };
        const at = ancestors(model!, n.id).map((a) => before.get(a)).find(Boolean);
        if (at) def.position = { x: at.x + (Math.random() - 0.5) * 80, y: at.y + (Math.random() - 0.5) * 80 };
        added.push(def);
      }
      cy.add(added);
      cy.add(
        visible!.edges.map((e) => ({
          group: 'edges' as const,
          data: {
            id: e.id,
            source: e.from,
            target: e.to,
            count: e.count,
            cycleCount: e.cycleCount,
            level: e.level,
            added: e.added,
            removed: e.removed,
            ...(e.change ? { change: e.change } : {}),
          },
        })),
      );
      applyChangedOnly();
      if (!showEdges) cy.edges().addClass('edges-off');
    });
    if (incremental && added.length) {
      const fresh = new Set(added.map((d) => d.data.id!));
      const pinned = cy
        .nodes()
        .filter((n) => !n.hasClass('unchanged-hidden') && n.isChildless() && !fresh.has(n.id()) && before.has(n.id()));
      runLayout(pinned.toArray() as NodeSingular[]);
    }
    syncEmpty();
    if (counts) counts.textContent = summaryText();
    if (toggleAll) toggleAll.textContent = collapsed.size > 0 ? 'Expand all' : 'Collapse all';
    notifyElements();
  }

  /** Changed only: keep changed edges, their endpoints, and compounds holding a kept node. */
  function applyChangedOnly(): void {
    cy.elements().removeClass('unchanged-hidden');
    if (!changedOnly) return;
    const changed = cy.edges('[change]');
    const keep = changed.connectedNodes();
    keep.merge(keep.ancestors());
    cy.edges().not(changed).addClass('unchanged-hidden');
    cy.nodes().not(keep).addClass('unchanged-hidden');
  }

  /** Changed only with no changed edge on screen: show the empty message instead of a blank canvas. */
  function syncEmpty(): void {
    if (!model?.edges.length) return;
    const none = changedOnly && cy.edges('[change]').empty();
    if (none) {
      const anyChange = model.edges.some((e) => e.change);
      empty.textContent = anyChange
        ? 'No changed edges between the shown nodes; expand groups to see them.'
        : 'No dependency edges changed.';
    }
    const wasHidden = cyBox.hidden;
    empty.hidden = !none;
    cyBox.hidden = none;
    if (wasHidden && !none) cy.resize();
  }

  /** Fit to the shown elements; compound bounds only settle on the next frame after a display change. */
  function fitVisible(): void {
    requestAnimationFrame(() => {
      const shown = cy.elements(':visible');
      if (shown.nonempty()) cy.fit(shown, 30);
    });
  }

  function summaryText(): string {
    if (!model) return '';
    const level = model.edges.some((e) => e.level === 'module') ? 'dependency' : 'import';
    const shown = cy.edges().not('.unchanged-hidden, .rt').length;
    return `${fmt(cy.nodes().not('.unchanged-hidden').length)} nodes shown · ${fmt(model.edges.length)} ${level} edges (${fmt(shown)} shown) · ${cycles.components.length} cycle${cycles.components.length === 1 ? '' : 's'}`;
  }

  function toggle(id: string): void {
    const n = model?.nodes.get(id);
    if (!n || n.type !== 'group') return;
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    tip.hidden = true;
    update();
    if (changedOnly) fitVisible();
  }

  function focusCycle(members: string[]): void {
    if (!model) return;
    let changed = false;
    for (const m of members) for (const a of ancestors(model, m)) if (collapsed.delete(a)) changed = true;
    if (changed) {
      // Several groups may open at once; a full layout reads better than pinning everything.
      update(false);
      runLayout();
    }
    cy.elements().unselect();
    const set = new Set(members);
    const nodes = cy.nodes().filter((n) => set.has(n.id()));
    nodes.select();
    nodes.edgesWith(nodes).filter('[cycleCount > 0]').select();
    cy.fit(nodes, 60);
  }

  function renderSide(): void {
    if (!model) return;
    const h = document.createElement('h3');
    h.textContent = `Cycles (${cycles.components.length})`;
    side.replaceChildren(h);
    if (!cycles.components.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No dependency cycles.';
      side.append(p);
      return;
    }
    const ul = document.createElement('ul');
    for (const comp of cycles.components) {
      const path = cyclePath(model, comp);
      const kinds = comp.map((id) => model!.nodes.get(id)?.kind ?? '');
      const allFiles = kinds.every((k) => k === 'file');
      const allOpaque = kinds.every(isOpaqueKind);
      // Files read fine by basename; package ids are only meaningful in full.
      const label = (id: string) => (isOpaqueKind(model!.nodes.get(id)?.kind ?? '') ? id : basename(id));
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const more = comp.length > path.length ? ` (+${comp.length - path.length} more)` : '';
      const noun = allFiles ? 'files' : allOpaque ? `${kinds[0] === 'module' ? 'module' : kinds[0]}s` : 'nodes';
      b.textContent = `${comp.length} ${noun}: ${path.map(label).join(' → ')}${more}`;
      b.title = [...path, path[0]].join('\n→ ');
      b.addEventListener('click', () => focusCycle(comp));
      li.append(b);
      ul.append(li);
    }
    side.append(ul);
  }

  function renderBar(): void {
    if (!snap) return;
    const ref = document.createElement('strong');
    ref.textContent = snap.ref || snap.sha.slice(0, 7);
    const sha = document.createElement('code');
    sha.textContent = snap.sha.slice(0, 12);
    counts = document.createElement('span');
    counts.className = 'muted';
    counts.textContent = summaryText();
    const hint = document.createElement('span');
    hint.className = 'muted graph-hint';
    hint.textContent = 'Double-click a group to expand/collapse';
    const btn = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    toggleAll = btn('', () => {
      if (!model) return;
      collapsed = collapsed.size > 0 ? new Set() : groupsBelow(model, 1);
      tip.hidden = true;
      update(false);
      runLayout();
      fitVisible();
    });
    toggleAll.textContent = collapsed.size > 0 ? 'Expand all' : 'Collapse all';
    const tools = document.createElement('span');
    tools.className = 'graph-tools';
    tools.append(
      btn('Fit', () => fitVisible()),
      btn('Re-layout', () => {
        runLayout();
        fitVisible();
      }),
      toggleAll,
    );
    bar.replaceChildren(ref, sha, counts, tierBadges(snap.languages), hint, tools);
    if (opts.barExtra) bar.append(opts.barExtra());
  }

  function showTip(lines: { title: string; rows: Array<[string, string]> }, pos: Position): void {
    const title = document.createElement('div');
    title.className = 'tm-tip-path';
    title.textContent = lines.title;
    const dl = document.createElement('dl');
    for (const [k, v] of lines.rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    tip.replaceChildren(title, dl);
    tip.hidden = false;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    let x = pos.x + 14;
    let y = pos.y + 14;
    if (x + tip.offsetWidth > w) x = Math.max(0, pos.x - tip.offsetWidth - 14);
    if (y + tip.offsetHeight > h) y = Math.max(0, pos.y - tip.offsetHeight - 14);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  const na = (v: number | undefined) => (v === undefined ? 'n/a' : fmt(v));
  /** Model edges leaving / entering `id` and everything under it (correct for expanded compounds too). */
  function crossing(id: string): { out: number; in: number } {
    const inside = (x: string) => x === id || ancestors(model!, x).includes(id);
    let o = 0;
    let i = 0;
    for (const e of model!.edges) {
      const f = inside(e.from);
      const t = inside(e.to);
      if (f && !t) o++;
      else if (t && !f) i++;
    }
    return { out: o, in: i };
  }

  cy.on('mouseover', 'node', (e) => {
    const n = model?.nodes.get((e.target as NodeSingular).id());
    if (!n) return;
    const rows: Array<[string, string]> = [];
    if (n.type === 'group' || isOpaqueKind(n.kind)) {
      rows.push(['Files', na(n.fileCount)], ['Code', `${na(n.code)} lines`]);
    } else if (boxes && filesByPath.has(n.id)) {
      // Same rows as the treemap tooltip.
      const f = filesByPath.get(n.id)!;
      rows.push(['Lines', `${fmtOr(f.loc)} loc / ${fmtOr(f.code)} code / ${fmtOr(f.comments)} comments`]);
      rows.push(['Complexity', f.complexity ? `${f.complexity.sum} sum / ${f.complexity.max} max / ${f.complexity.functions} functions` : 'n/a']);
      rows.push(['Churn', f.churn ? `${f.churn.commits} commits / ${f.churn.authors} authors` : 'n/a']);
      rows.push(...overlayTipRows(n.id));
    } else if (n.metrics) {
      rows.push(['Code', `${na(n.metrics.code)} lines`]);
      rows.push(['Complexity', `${na(n.metrics.complexityMax)} max`]);
      rows.push(['Churn', `${na(n.metrics.churnCommits)} commits`]);
      if (colored && n.kind === 'file') rows.push(...overlayTipRows(n.id));
    }
    if (isOpaqueKind(n.kind) && n.type === 'leaf') rows.unshift(['Kind', n.kind]);
    if (n.ghost) rows.unshift(['Status', 'removed (base only)']);
    const c = crossing(n.id);
    rows.push(['Imports', `${fmt(c.out)} out / ${fmt(c.in)} in`]);
    if (tipExtra) rows.push(...tipExtra(n.id));
    const title = n.type === 'group' && !n.id.endsWith('/') ? `${n.id}/` : n.id;
    showTip({ title, rows }, e.renderedPosition);
  });
  cy.on('mouseover', 'edge', (e) => {
    const el = e.target as EdgeSingular;
    const ends = { from: el.source().id(), to: el.target().id() };
    if (el.hasClass('rt')) {
      showTip({ title: `${ends.from} → ${ends.to}`, rows: [['Import edge', 'none (runtime only)'], ...(tipExtra?.(el.id(), ends) ?? [])] }, e.renderedPosition);
      return;
    }
    const count = el.data('count') as number;
    const inCycle = el.data('cycleCount') as number;
    const added = (el.data('added') as number) ?? 0;
    const removed = (el.data('removed') as number) ?? 0;
    const rows: Array<[string, string]> = [
      ['Imports', added || removed ? `${fmt(count)} · +${fmt(added)} added · −${fmt(removed)} removed` : fmt(count)],
    ];
    if (el.data('level') === 'module') rows.push(['Level', 'module']);
    if (inCycle) rows.push(['In cycles', fmt(inCycle)]);
    if (tipExtra) rows.push(...tipExtra(el.id(), ends));
    showTip({ title: `${el.source().id()} → ${el.target().id()}`, rows }, e.renderedPosition);
  });
  cy.on('mouseout', () => (tip.hidden = true));
  cy.on('viewport', () => (tip.hidden = true));
  cy.on('cxttap', 'node', (e) => {
    const n = model?.nodes.get((e.target as NodeSingular).id());
    const ev = e.originalEvent as MouseEvent | undefined;
    if (!n || n.ghost || !ev || !opts.onContextMenu) return;
    const kind = n.type === 'leaf' && n.kind === 'file' ? 'file' : n.type === 'group' && n.kind === 'dir' ? 'dir' : null;
    if (!kind) return;
    tip.hidden = true;
    opts.onContextMenu({ kind, path: n.id }, ev);
  });
  cy.on('dbltap', 'node', (e) => toggle((e.target as NodeSingular).id()));

  const ro = new ResizeObserver(() => cy.resize());
  ro.observe(stage);

  return {
    el: container,
    render(next, prebuilt) {
      snap = next;
      model = prebuilt ?? buildGraphModel(next, { allFiles: boxes });
      if (colored) {
        filesByPath = new Map(next.files.map((f) => [f.path, f]));
        scale = colorScale(next.files, colorMode);
      }
      cycles = findCycles(model);
      // Start collapsed: only the repo root's direct children are open.
      collapsed = groupsBelow(model, 1);
      cy.elements().remove();
      visible = null; // so the summary never shows the previous snapshot's counts
      tip.hidden = true;
      // The map shows every file, so it has something to draw even without edges.
      const hasEdges = model.edges.length > 0 || (boxes && model.nodes.size > 0);
      empty.hidden = hasEdges;
      cyBox.hidden = !hasEdges;
      side.hidden = !hasEdges;
      renderBar();
      if (!hasEdges) {
        empty.textContent = 'No dependency edges in this snapshot.';
        notifyElements();
        return;
      }
      cy.resize();
      update(false);
      const ms = runLayout();
      fitVisible();
      container.dataset.layoutMs = ms.toFixed(0);
      renderSide();
    },
    cy,
    stage,
    edgesShown: () => showEdges,
    model: () => model,
    visible: () => visible,
    onElements(fn) {
      elementListeners.add(fn);
      return () => elementListeners.delete(fn);
    },
    setTipExtra(fn) {
      tipExtra = fn;
    },
    setChangedOnly(on) {
      if (on === changedOnly) return;
      changedOnly = on;
      tip.hidden = true;
      cy.batch(applyChangedOnly);
      syncEmpty();
      if (counts) counts.textContent = summaryText();
      fitVisible();
    },
    resize(fit) {
      cy.resize();
      if (fit) fitVisible();
    },
    setColorMode(mode, force = false) {
      if (mode === colorMode && !force) return;
      colorMode = mode;
      if (!colored || !snap) return;
      scale = colorScale(snap.files, colorMode);
      cy.batch(() => {
        if (!boxes) cy.nodes('[dot]').forEach((n) => void n.data('dot', fileColor(n.id())));
        cy.nodes('[?box][type = "leaf"][kind = "file"]').forEach((n) => {
          const bg = fileColor(n.id());
          n.data({ bg, fg: textOn(bg) });
        });
      });
    },
    setShowEdges(on) {
      if (on === showEdges) return;
      showEdges = on;
      tip.hidden = true;
      if (on) cy.edges().removeClass('edges-off');
      else cy.edges().addClass('edges-off');
      notifyElements();
    },
    destroy() {
      ro.disconnect();
      cy.destroy();
      container.replaceChildren();
      container.classList.remove('graph');
    },
  };
}
