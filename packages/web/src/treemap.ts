import type { FileEntry } from '@codeviz/core';
import { hierarchy, treemap, type HierarchyRectangularNode } from 'd3-hierarchy';
import { scaleLinear, scaleSequential } from 'd3-scale';
import { interpolateBlues, interpolateOranges } from 'd3-scale-chromatic';
import type { Snapshot } from './data.ts';

export type ColorMode = 'complexity' | 'churn';

/** Directory (has children) or file (has file + value) in the path tree. */
export interface TreeNode {
  name: string;
  path: string;
  file?: FileEntry;
  value?: number;
  children?: TreeNode[];
}

/** Files with size info, nested by path segment. Single-child directory chains are merged ("a/b"). */
export function buildHierarchy(files: FileEntry[], rootName = ''): TreeNode {
  const root: TreeNode = { name: rootName, path: '', children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  for (const f of files) {
    if (f.code === undefined && f.loc === undefined) continue;
    const parts = f.path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let dir = dirs.get(path);
      if (!dir) {
        dir = { name: parts[i]!, path, children: [] };
        dirs.set(path, dir);
        parent.children!.push(dir);
      }
      parent = dir;
    }
    parent.children!.push({
      name: parts[parts.length - 1]!,
      path: f.path,
      file: f,
      value: Math.max(1, f.code ?? f.loc ?? 0),
    });
  }
  const compress = (node: TreeNode): TreeNode => {
    let n = node;
    while (n !== root && n.children?.length === 1 && n.children[0]!.children) {
      const only = n.children[0]!;
      n = { name: `${n.name}/${only.name}`, path: only.path, children: only.children };
    }
    if (n.children) n.children = n.children.map(compress);
    return n;
  };
  return compress(root);
}

export function metric(f: FileEntry, mode: ColorMode): number | undefined {
  return mode === 'complexity' ? f.complexity?.max : f.churn?.commits;
}

export interface ColorScale {
  mode: ColorMode;
  /** [0, hi]: hi is the 95th percentile rounded up to a nice number; values above clamp. */
  domain: [number, number];
  /** Largest observed value (above hi when the scale clamps). */
  max: number;
  color(v: number | undefined): string;
}

export const NA_FILL = 'url(#tm-na)';

export function colorScale(files: FileEntry[], mode: ColorMode): ColorScale {
  const vals = files
    .filter((f) => f.code !== undefined || f.loc !== undefined)
    .map((f) => metric(f, mode))
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  const p95 = vals.length ? vals[Math.floor(0.95 * (vals.length - 1))]! : 1;
  const hi = Math.max(1, scaleLinear().domain([0, p95]).nice().domain()[1]!);
  const interp = mode === 'complexity' ? interpolateBlues : interpolateOranges;
  // Skip the near-white end so low values still read against the surface.
  const seq = scaleSequential((t: number) => interp(0.12 + 0.83 * t))
    .domain([0, hi])
    .clamp(true);
  return {
    mode,
    domain: [0, hi],
    max: vals.length ? vals[vals.length - 1]! : 0,
    color: (v) => (v === undefined ? NA_FILL : seq(v)),
  };
}

export function legendLabel(mode: ColorMode, snap: Snapshot): string {
  return mode === 'complexity' ? 'Max complexity per file' : `Commits (last ${snap.since ?? 'window'})`;
}

/** Gradient bar with min/max labels plus a hatched "n/a" swatch. */
export function createLegend(scale: ColorScale, label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'legend';
  const title = document.createElement('span');
  title.className = 'legend-title';
  title.textContent = label;
  const lo = document.createElement('span');
  lo.textContent = String(scale.domain[0]);
  const bar = document.createElement('span');
  bar.className = 'legend-bar';
  const stops = Array.from({ length: 9 }, (_, i) => scale.color((scale.domain[1] * i) / 8));
  bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  const hi = document.createElement('span');
  hi.textContent = scale.max > scale.domain[1] ? `${scale.domain[1]}+` : String(scale.domain[1]);
  if (scale.max > scale.domain[1]) hi.title = `Clamped at the 95th percentile; max is ${scale.max}`;
  const na = document.createElement('span');
  na.className = 'legend-na';
  const naLabel = document.createElement('span');
  naLabel.textContent = 'n/a';
  el.append(title, lo, bar, hi, na, naLabel);
  return el;
}

export interface Treemap {
  render(snap: Snapshot, mode: ColorMode): void;
  setMode(mode: ColorMode): void;
  /** Zoom to the file's directory and outline it. */
  reveal(path: string): void;
  destroy(): void;
}

/** Overrides the metric coloring (used by the compare view's delta treemap). */
export interface TreemapStyle {
  fill(f: FileEntry): string;
  className?(f: FileEntry): string | undefined;
  tipRows?(f: FileEntry): Array<[string, string]>;
  /** Extra marks drawn over the file's block and under its label (should not take pointer events). */
  overlay?(f: FileEntry, box: { x: number; y: number; w: number; h: number }): SVGElement | null;
}

const SVG = 'http://www.w3.org/2000/svg';
const DIR_HEADER = 16;
const CHAR_W = 6.4;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function fit(text: string, width: number): string | null {
  const max = Math.floor((width - 6) / CHAR_W);
  if (max < 3) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Light text on dark fills. Interpolators return "rgb(r, g, b)". */
function inkFor(fill: string): string {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(fill);
  if (!m) return '#1d2025';
  const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? '#fff' : '#1d2025';
}

const fmt = (n: number) => n.toLocaleString();

export function createTreemap(
  container: HTMLElement,
  opts: { onFileClick?(path: string): void; style?: TreemapStyle } = {},
): Treemap {
  const style = opts.style;
  container.classList.add('treemap');
  const crumbs = document.createElement('nav');
  crumbs.className = 'tm-crumbs';
  const stage = document.createElement('div');
  stage.className = 'tm-stage';
  const root = svg('svg', { class: 'tm-svg' });
  const tip = document.createElement('div');
  tip.className = 'tm-tip';
  tip.hidden = true;
  stage.append(root, tip);
  container.replaceChildren(crumbs, stage);

  let snap: Snapshot | null = null;
  let mode: ColorMode = 'complexity';
  let tree: TreeNode | null = null;
  let dirIndex = new Map<string, TreeNode>();
  let parentOf = new Map<TreeNode, TreeNode>();
  let focus = '';
  let selected: string | null = null;
  let nodes: HierarchyRectangularNode<TreeNode>[] = [];

  function index(t: TreeNode): void {
    dirIndex = new Map();
    parentOf = new Map();
    const walk = (n: TreeNode) => {
      if (!n.children) return;
      dirIndex.set(n.path, n);
      for (const c of n.children) {
        parentOf.set(c, n);
        walk(c);
      }
    };
    walk(t);
  }

  /** Deepest existing directory at or above `path` (focus survives ref switches when possible). */
  function resolve(path: string): TreeNode {
    let p = path;
    while (p && !dirIndex.has(p)) p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    return dirIndex.get(p) ?? tree!;
  }

  function drawCrumbs(node: TreeNode): void {
    const chain: TreeNode[] = [];
    for (let n: TreeNode | undefined = node; n; n = parentOf.get(n)) chain.unshift(n);
    crumbs.replaceChildren();
    chain.forEach((n, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'tm-sep';
        sep.textContent = '/';
        crumbs.append(sep);
      }
      const last = i === chain.length - 1;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = n.name || '(root)';
      b.disabled = last;
      if (!last) b.addEventListener('click', () => zoom(n.path));
      crumbs.append(b);
    });
    const hint = document.createElement('span');
    hint.className = 'tm-hint';
    hint.textContent = chain.length > 1 ? 'Esc to zoom out' : 'Click a directory to zoom';
    crumbs.append(hint);
  }

  function draw(): void {
    if (!snap || !tree) return;
    const { width, height } = stage.getBoundingClientRect();
    if (width < 10 || height < 10) return;
    const focusNode = resolve(focus);
    focus = focusNode.path;
    drawCrumbs(focusNode);
    tip.hidden = true;

    const scale = style ? null : colorScale(snap.files, mode);
    const h = hierarchy(focusNode)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const laid = treemap<TreeNode>()
      .size([width, height])
      .paddingInner(2)
      .paddingOuter((d) => (d.depth === 0 ? 0 : 2))
      .paddingTop((d) => (d.depth === 0 ? 0 : DIR_HEADER))
      .round(true)(h);
    nodes = laid.descendants();

    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const defs = svg('defs', {});
    const pat = svg('pattern', { id: 'tm-na', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(svg('rect', { width: 6, height: 6, fill: '#ecedf0' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#c5c8ce', 'stroke-width': 2 }));
    // Red hatch for removed files in the delta treemap.
    const rm = svg('pattern', { id: 'tm-removed', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    rm.append(svg('rect', { width: 6, height: 6, fill: '#ffebe9' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#ff8182', 'stroke-width': 2 }));
    defs.append(pat, rm);
    const frag = document.createDocumentFragment();
    frag.append(defs);

    nodes.forEach((n, i) => {
      if (n.depth === 0) return;
      const w = n.x1 - n.x0;
      const ht = n.y1 - n.y0;
      if (w < 1 || ht < 1) return;
      if (n.data.children) {
        const g = svg('g', { class: 'tm-dir', 'data-i': i });
        g.append(svg('rect', { x: n.x0, y: n.y0, width: w, height: ht }));
        const label = fit(n.data.name, w);
        if (label && ht > DIR_HEADER) {
          const t = svg('text', { x: n.x0 + 4, y: n.y0 + 12 });
          t.textContent = label;
          g.append(t);
        }
        frag.append(g);
      } else {
        const file = n.data.file!;
        const fill = style ? style.fill(file) : scale!.color(metric(file, mode));
        const cls = ['tm-file', style?.className?.(file), file.path === selected ? 'tm-selected' : undefined];
        frag.append(svg('rect', { class: cls.filter(Boolean).join(' '), 'data-i': i, 'data-path': file.path, x: n.x0, y: n.y0, width: w, height: ht, fill }));
        const extra = style?.overlay?.(file, { x: n.x0, y: n.y0, w, h: ht });
        if (extra) frag.append(extra);
        const label = ht >= 14 ? fit(n.data.name, w) : null;
        if (label) {
          const t = svg('text', { class: 'tm-label', x: n.x0 + 3, y: n.y0 + 11, fill: inkFor(fill) });
          t.textContent = label;
          frag.append(t);
        }
      }
    });
    root.replaceChildren(frag);
  }

  function zoom(path: string): void {
    focus = path;
    draw();
  }

  function nodeAt(e: Event): HierarchyRectangularNode<TreeNode> | null {
    const el = (e.target as Element).closest('[data-i]');
    return el ? (nodes[Number(el.getAttribute('data-i'))] ?? null) : null;
  }

  function showTip(n: HierarchyRectangularNode<TreeNode>, e: PointerEvent): void {
    const rows: Array<[string, string]> = [];
    const f = n.data.file;
    if (f && style?.tipRows) {
      rows.push(...style.tipRows(f));
    } else if (f) {
      rows.push(['Lines', `${f.loc ?? 'n/a'} loc / ${f.code ?? 'n/a'} code / ${f.comments ?? 'n/a'} comments`]);
      rows.push(['Complexity', f.complexity ? `${f.complexity.sum} sum / ${f.complexity.max} max / ${f.complexity.functions} functions` : 'n/a']);
      rows.push(['Churn', f.churn ? `${f.churn.commits} commits / ${f.churn.authors} authors` : 'n/a']);
    } else {
      rows.push(['Files', fmt(n.leaves().length)]);
      rows.push(['Code', `${fmt(n.value ?? 0)} lines`]);
    }
    const title = document.createElement('div');
    title.className = 'tm-tip-path';
    title.textContent = n.data.path + (f ? '' : '/');
    const dl = document.createElement('dl');
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    tip.replaceChildren(title, dl);
    tip.hidden = false;
    const box = stage.getBoundingClientRect();
    let x = e.clientX - box.left + 14;
    let y = e.clientY - box.top + 14;
    if (x + tip.offsetWidth > box.width) x = Math.max(0, e.clientX - box.left - tip.offsetWidth - 14);
    if (y + tip.offsetHeight > box.height) y = Math.max(0, e.clientY - box.top - tip.offsetHeight - 14);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  const onMove = (e: PointerEvent) => {
    const n = nodeAt(e);
    if (n) showTip(n, e);
    else tip.hidden = true;
  };
  const onLeave = () => {
    tip.hidden = true;
  };
  const onClick = (e: MouseEvent) => {
    const n = nodeAt(e);
    if (!n) return;
    if (n.data.children) zoom(n.data.path);
    else opts.onFileClick?.(n.data.path);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !tree || !focus) return;
    const parent = parentOf.get(resolve(focus));
    if (parent) zoom(parent.path);
  };
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerleave', onLeave);
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);

  let frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  });
  ro.observe(stage);

  return {
    render(next, nextMode) {
      snap = next;
      mode = nextMode;
      tree = buildHierarchy(next.files, next.repo);
      index(tree);
      draw();
    },
    setMode(nextMode) {
      if (nextMode === mode) return;
      mode = nextMode;
      draw();
    },
    reveal(path) {
      selected = path;
      focus = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      draw();
    },
    destroy() {
      ro.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      container.replaceChildren();
      container.classList.remove('treemap');
    },
  };
}
