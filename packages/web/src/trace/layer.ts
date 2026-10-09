// Draws trace heat onto one graph/map view; never adds nodes, never runs layout.
//
// Playback draws on a canvas stacked over the Cytoscape canvas, in Cytoscape's own pan/zoom
// transform: node glows, pulsing import edges and dashed runtime-only edges. Restyling Cytoscape
// elements per frame is too slow on compound graphs (each style change invalidates the cached style
// of the element's ancestors and connected edges; ~0.7 ms per element on the 400-file Capacitor map).
//
// Summary is drawn once, by restyling Cytoscape (style bypasses and two classes), so it stays
// interactive (tooltips) and runtime-only edges are real `rt` edges, which the view keeps out of layout.
import type { ElementDefinition, NodeSingular, SingularElementReturnValue } from 'cytoscape';
import type { GraphView } from '../graph/view.ts';
import { edgeKey } from '../graph/model.ts';
import { classifyEdges, intensity, type EdgeClasses, type Heat, type Totals } from './model.ts';

export interface HeatScale {
  peakFile: number;
  peakEdge: number;
  tickMs: number;
  decayMs: number;
}

export interface TraceLayer {
  /** Playback: light nodes/edges by `heat` (file paths / runtime keys). `now` drives the edge pulse. */
  frame(heat: Heat, scale: HeatScale, now: number): void;
  /** Summary: totals over the whole trace, edges split into three classes; returns model-level counts. */
  summary(t: Totals): EdgeClasses | null;
  /** Remove every trace style and drawing. */
  clear(): void;
  /** Tooltip rows come from here while a trace is shown. */
  setTip(fn: ((id: string, edge?: { from: string; to: string }) => Array<[string, string]>) | null): void;
  destroy(): void;
}

/** Same as HOT / RUNTIME in graph/view.ts. */
const HOT = '#f97316';
const RUNTIME = '#7c3aed';
const RT = 'rt:';
/** Properties the summary bypasses. */
const BYPASS = 'underlay-opacity line-color target-arrow-color line-style width opacity display';

interface Geo {
  x: number;
  y: number;
  hw: number;
  hh: number;
  box: boolean;
}

type Ele = SingularElementReturnValue;

/** Where the segment from the center of `a` toward (tx, ty) leaves a's shape. */
function exitPoint(a: Geo, tx: number, ty: number): [number, number] {
  const dx = tx - a.x;
  const dy = ty - a.y;
  if (dx === 0 && dy === 0) return [a.x, a.y];
  const t = a.box
    ? Math.min(dx ? a.hw / Math.abs(dx) : Infinity, dy ? a.hh / Math.abs(dy) : Infinity)
    : Math.min(a.hw, a.hh) / Math.hypot(dx, dy);
  return t >= 1 ? [a.x, a.y] : [a.x + dx * t, a.y + dy * t];
}

export function createTraceLayer(graph: GraphView, redraw: () => void): TraceLayer {
  const cy = graph.cy;
  const canvas = document.createElement('canvas');
  canvas.className = 'trace-canvas';
  graph.stage.append(canvas);
  const ctx = canvas.getContext('2d')!;

  let importIds = new Set<string>();
  /** Node geometry in model coordinates, filled lazily; dropped when elements move or change. */
  let geo = new Map<string, Geo | null>();
  /** Last playback drawing, repainted on pan/zoom while paused. */
  let last: { nodes: Map<string, number>; edges: Map<string, number>; now: number } | null = null;
  /** Summary state: bypassed element ids. */
  let lit = new Set<string>();
  let summaryOn = false;

  function reset(): void {
    importIds = new Set((graph.visible()?.edges ?? []).map((e) => e.id));
    geo = new Map();
  }
  reset();

  // The view rebuilt its elements (render, expand/collapse, Show edges): redraw from scratch.
  const off = graph.onElements(() => {
    unlightSummary();
    reset();
    last = null;
    paint();
    redraw();
  });
  const repaint = () => paint();
  const moved = () => {
    geo = new Map();
    paint();
  };
  cy.on('viewport resize', repaint);
  cy.on('position', 'node', moved);

  function geoOf(id: string): Geo | null {
    let g = geo.get(id);
    if (g === undefined) {
      const c = cy.getElementById(id);
      if (c.empty() || !c.visible()) g = null;
      else {
        const n = c as unknown as NodeSingular;
        const p = n.position();
        g = { x: p.x, y: p.y, hw: n.width() / 2, hh: n.height() / 2, box: !!n.data('box') || n.isParent() };
      }
      geo.set(id, g);
    }
    return g;
  }

  /** Map file-level keys to drawn node / edge ids (collapsed groups aggregate their files). */
  function project(files: Map<string, number>, edges: Map<string, number>): { nodes: Map<string, number>; edges: Map<string, number> } {
    const model = graph.model();
    const vis = graph.visible();
    const outN = new Map<string, number>();
    const outE = new Map<string, number>();
    if (!model || !vis) return { nodes: outN, edges: outE };
    for (const [p, h] of files) {
      if (!model.nodes.has(p)) continue;
      const r = vis.repOf(p);
      outN.set(r, (outN.get(r) ?? 0) + h);
    }
    for (const [k, h] of edges) {
      const nl = k.indexOf('\n');
      const from = k.slice(0, nl);
      const to = k.slice(nl + 1);
      if (!model.nodes.has(from) || !model.nodes.has(to)) continue;
      const rf = vis.repOf(from);
      const rt = vis.repOf(to);
      if (rf === rt) continue;
      const id = edgeKey(rf, rt);
      const eid = importIds.has(id) ? id : RT + id;
      outE.set(eid, (outE.get(eid) ?? 0) + h);
    }
    return { nodes: outN, edges: outE };
  }

  const ends = (eid: string): [string, string] => {
    const k = eid.startsWith(RT) ? eid.slice(RT.length) : eid;
    const nl = k.indexOf('\n');
    return [k.slice(0, nl), k.slice(nl + 1)];
  };

  /** Repaint the overlay from `last` (empty in summary mode). */
  function paint(): void {
    const w = graph.stage.clientWidth;
    const h = graph.stage.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!last || summaryOn) return;
    const z = cy.zoom();
    const pan = cy.pan();
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * pan.x, dpr * pan.y);
    const px = 1 / z; // one screen pixel in model units

    if (graph.edgesShown()) {
      ctx.lineCap = 'round';
      const march = -((last.now / 25) % 28) * px;
      for (const [eid, v] of last.edges) {
        const [s, t] = ends(eid);
        const a = geoOf(s);
        const b = geoOf(t);
        if (!a || !b) continue;
        const rt = eid.startsWith(RT);
        const color = rt ? RUNTIME : HOT;
        ctx.globalAlpha = 0.3 + 0.6 * v;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = (1.2 + 3 * v) * px;
        ctx.setLineDash(rt ? [5 * px, 4 * px] : [10 * px, 4 * px]);
        ctx.lineDashOffset = march;
        // Runtime-only edges bow to the side so one running against an import edge stays visible.
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const bow = rt ? Math.min(60 * px, len * 0.25) : 0;
        const cx = (a.x + b.x) / 2 - ((b.y - a.y) / len) * bow;
        const cyy = (a.y + b.y) / 2 + ((b.x - a.x) / len) * bow;
        const [x1, y1] = exitPoint(a, cx, cyy);
        const [x2, y2] = exitPoint(b, cx, cyy);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        if (rt) ctx.quadraticCurveTo(cx, cyy, x2, y2);
        else ctx.lineTo(x2, y2);
        ctx.stroke();
        // Arrowhead at the callee.
        const ang = Math.atan2(y2 - cyy, x2 - cx);
        const head = (6 + 4 * v) * px;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
        ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
      ctx.setLineDash([]);
    }

    for (const [id, v] of last.nodes) {
      const g = geoOf(id);
      if (!g) continue;
      const pad = (2 + 3 * v) * px;
      ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(249, 115, 22, ${(0.12 + 0.3 * v).toFixed(3)})`;
      ctx.strokeStyle = HOT;
      ctx.lineWidth = (1.5 + 3.5 * v) * px;
      ctx.beginPath();
      if (g.box) ctx.rect(g.x - g.hw - pad, g.y - g.hh - pad, 2 * (g.hw + pad), 2 * (g.hh + pad));
      else ctx.ellipse(g.x, g.y, g.hw + pad, g.hh + pad, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.4 + 0.6 * v;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function ele(id: string): Ele | null {
    const c = cy.getElementById(id);
    return c.nonempty() ? (c as Ele) : null;
  }

  function unlightSummary(): void {
    if (!summaryOn) return;
    cy.batch(() => {
      for (const id of lit) ele(id)?.removeStyle(BYPASS);
      cy.edges('.tr-called, .tr-uncalled').removeClass('tr-called tr-uncalled');
      cy.edges('.rt').remove();
    });
    lit = new Set();
    summaryOn = false;
  }

  const layer: TraceLayer = {
    frame(heat, s, now) {
      if (summaryOn) unlightSummary();
      const p = project(heat.files, heat.edges);
      const nodes = new Map<string, number>();
      const edges = new Map<string, number>();
      for (const [id, h] of p.nodes) {
        const v = intensity(h, s.peakFile, s.tickMs, s.decayMs);
        if (v > 0.02) nodes.set(id, v);
      }
      for (const [id, h] of p.edges) {
        const v = intensity(h, s.peakEdge, s.tickMs, s.decayMs);
        if (v > 0.02) edges.set(id, v);
      }
      last = { nodes, edges, now };
      paint();
    },
    summary(t) {
      const model = graph.model();
      if (!model) return null;
      unlightSummary();
      last = null;
      summaryOn = true;
      paint();
      const p = project(t.files, t.edges);
      const maxN = Math.max(1, ...p.nodes.values());
      const maxE = Math.max(1, ...p.edges.values());
      const level = (h: number, max: number) => Math.max(0.1, Math.log1p(h) / Math.log1p(max));
      const shown = graph.edgesShown();
      cy.batch(() => {
        const defs: ElementDefinition[] = [];
        for (const eid of p.edges.keys()) {
          if (!eid.startsWith(RT)) continue;
          const [source, target] = ends(eid);
          if (ele(source) && ele(target)) defs.push({ group: 'edges', data: { id: eid, source, target }, classes: shown ? 'rt' : 'rt edges-off' });
        }
        if (defs.length) cy.add(defs);
        for (const [id, h] of p.nodes) {
          const e = ele(id);
          if (!e) continue;
          e.style('underlay-opacity', 0.15 + 0.75 * level(h, maxN));
          lit.add(id);
        }
        for (const [id, h] of p.edges) {
          const e = ele(id);
          if (!e) continue;
          const rt = id.startsWith(RT);
          const color = rt ? RUNTIME : HOT;
          e.style({
            'line-color': color,
            'target-arrow-color': color,
            'line-style': rt ? 'dashed' : 'solid',
            width: 1.5 + 5 * level(h, maxE),
            opacity: 1,
            ...(rt && shown ? { display: 'element' } : {}),
          });
          lit.add(id);
        }
        cy.edges()
          .not('.rt')
          .forEach((e) => {
            const called = p.edges.has(e.id());
            e.toggleClass('tr-called', called);
            e.toggleClass('tr-uncalled', !called);
          });
      });
      const importKeys = model.edges.filter((e) => e.change !== 'removed' && e.level === 'file').map((e) => e.key);
      return classifyEdges(importKeys, t.edges);
    },
    clear() {
      unlightSummary();
      last = null;
      paint();
    },
    setTip(fn) {
      graph.setTipExtra(fn);
    },
    destroy() {
      off();
      cy.off('viewport resize', repaint);
      cy.off('position', 'node', moved);
      layer.clear();
      canvas.remove();
      graph.setTipExtra(null);
    },
  };
  return layer;
}
