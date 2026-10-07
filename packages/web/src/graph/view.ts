import cytoscape, { type Core, type ElementDefinition, type NodeSingular, type EdgeSingular, type Position } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { Snapshot } from '../data.ts';
import { tierBadges } from '../refpicker.ts';
import {
  aggregateEdges,
  ancestors,
  buildGraphModel,
  cyclePath,
  findCycles,
  isOpaqueKind,
  type Cycles,
  type GraphModel,
  type VisibleGraph,
} from './model.ts';

cytoscape.use(fcose);

/** Above this many visible nodes the initial/full layout uses faster settings. */
const LARGE_GRAPH_NODES = 250;

export interface GraphView {
  readonly el: HTMLElement;
  render(snap: Snapshot): void;
  destroy(): void;
}

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
  { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#2f6fdb' } },
  { selector: 'edge:selected', style: { 'line-color': '#2f6fdb', 'target-arrow-color': '#2f6fdb' } },
];

/** Dependency graph: directories as collapsible compound nodes, cycle edges in red, cycle list on the side. */
export function createGraphView(container: HTMLElement): GraphView {
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

  const cy: Core = cytoscape({
    container: cyBox,
    style: STYLE,
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

  function nodeData(n: VisibleGraph['nodes'][number]): Record<string, unknown> {
    const group = n.type === 'group';
    const hasKids = group && !n.collapsed;
    return {
      id: n.id,
      parent: n.parent ?? undefined,
      type: n.type,
      kind: n.kind,
      opaque: isOpaqueKind(n.kind),
      label: group ? `${hasKids ? '▾' : '▸'} ${n.label}` : n.label,
      size: group || isOpaqueKind(n.kind) ? Math.round(22 + 5 * Math.sqrt(n.fileCount ?? 0)) : 14,
    };
  }

  function runLayout(eles: Core, fixed: NodeSingular[] = []): number {
    const t = performance.now();
    const incremental = fixed.length > 0;
    // Big graphs get fcose's faster draft quality with fewer iterations.
    const large = eles.nodes().length > LARGE_GRAPH_NODES;
    eles
      .layout({
        name: 'fcose',
        animate: false,
        randomize: !incremental,
        quality: incremental ? 'proof' : large ? 'draft' : 'default',
        ...(large ? { numIter: 1000 } : {}),
        nodeDimensionsIncludeLabels: true,
        idealEdgeLength: 70,
        nodeRepulsion: 6500,
        nestingFactor: 0.4,
        packComponents: false,
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
          data: { id: e.id, source: e.from, target: e.to, count: e.count, cycleCount: e.cycleCount, level: e.level },
        })),
      );
    });
    if (incremental && added.length) {
      const fresh = new Set(added.map((d) => d.data.id!));
      const pinned = cy.nodes().filter((n) => n.isChildless() && !fresh.has(n.id()) && before.has(n.id()));
      runLayout(cy, pinned.toArray() as NodeSingular[]);
    }
    if (counts) counts.textContent = summaryText();
  }

  function summaryText(): string {
    if (!model) return '';
    const level = model.edges.some((e) => e.level === 'module') ? 'dependency' : 'import';
    const shown = visible ? visible.edges.length : 0;
    return `${fmt(visible ? visible.nodes.length : 0)} nodes shown · ${fmt(model.edges.length)} ${level} edges (${fmt(shown)} shown) · ${cycles.components.length} cycle${cycles.components.length === 1 ? '' : 's'}`;
  }

  function toggle(id: string): void {
    const n = model?.nodes.get(id);
    if (!n || n.type !== 'group') return;
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    tip.hidden = true;
    update();
  }

  function focusCycle(members: string[]): void {
    if (!model) return;
    let changed = false;
    for (const m of members) for (const a of ancestors(model, m)) if (collapsed.delete(a)) changed = true;
    if (changed) {
      // Several groups may open at once; a full layout reads better than pinning everything.
      update(false);
      runLayout(cy);
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
    const btn = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    const tools = document.createElement('span');
    tools.className = 'graph-tools';
    tools.append(
      btn('Fit', () => cy.fit(undefined, 30)),
      btn('Re-layout', () => {
        runLayout(cy);
        cy.fit(undefined, 30);
      }),
    );
    bar.replaceChildren(ref, sha, counts, tierBadges(snap.languages), hint, tools);
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
    } else if (n.metrics) {
      rows.push(['Code', `${na(n.metrics.code)} lines`]);
      rows.push(['Complexity', `${na(n.metrics.complexityMax)} max`]);
      rows.push(['Churn', `${na(n.metrics.churnCommits)} commits`]);
    }
    if (isOpaqueKind(n.kind) && n.type === 'leaf') rows.unshift(['Kind', n.kind]);
    const c = crossing(n.id);
    rows.push(['Imports', `${fmt(c.out)} out / ${fmt(c.in)} in`]);
    const title = n.type === 'group' && !n.id.endsWith('/') ? `${n.id}/` : n.id;
    showTip({ title, rows }, e.renderedPosition);
  });
  cy.on('mouseover', 'edge', (e) => {
    const el = e.target as EdgeSingular;
    const count = el.data('count') as number;
    const inCycle = el.data('cycleCount') as number;
    const rows: Array<[string, string]> = [['Imports', fmt(count)]];
    if (el.data('level') === 'module') rows.push(['Level', 'module']);
    if (inCycle) rows.push(['In cycles', fmt(inCycle)]);
    showTip({ title: `${el.source().id()} → ${el.target().id()}`, rows }, e.renderedPosition);
  });
  cy.on('mouseout', () => (tip.hidden = true));
  cy.on('viewport', () => (tip.hidden = true));
  cy.on('dbltap', 'node', (e) => toggle((e.target as NodeSingular).id()));

  const ro = new ResizeObserver(() => cy.resize());
  ro.observe(stage);

  return {
    el: container,
    render(next) {
      snap = next;
      model = buildGraphModel(next);
      cycles = findCycles(model);
      // Start fully expanded: every directory open, every file visible.
      collapsed = new Set();
      cy.elements().remove();
      visible = null; // so the summary never shows the previous snapshot's counts
      tip.hidden = true;
      const hasEdges = model.edges.length > 0;
      empty.hidden = hasEdges;
      cyBox.hidden = !hasEdges;
      side.hidden = !hasEdges;
      renderBar();
      if (!hasEdges) {
        empty.textContent = 'No dependency edges in this snapshot.';
        return;
      }
      cy.resize();
      update(false);
      const ms = runLayout(cy);
      cy.fit(undefined, 30);
      container.dataset.layoutMs = ms.toFixed(0);
      renderSide();
    },
    destroy() {
      ro.disconnect();
      cy.destroy();
      container.replaceChildren();
      container.classList.remove('graph');
    },
  };
}
