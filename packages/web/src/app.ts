import type { CompareView } from './compare/view.ts';
import { isAnalyzed, WORKTREE, type DataSource, type Snapshot, type SnapshotIndex } from './data.ts';
import { createHiddenStore, filterDiff, filterSnapshot, type HiddenStore, type HideTarget } from './hidden.ts';
import { createHiddenUI, type HiddenUI } from './hiddenui.ts';
import { createRefPicker, tierBadges, type RefPicker } from './refpicker.ts';
import { colorScale, createLegend, createTreemap, legendLabel, type ColorMode, type Treemap } from './treemap.ts';

export interface App {
  source: DataSource;
  picker: RefPicker;
  /** Main content area: the active view (summary bar + treemap or graph) once a snapshot is loaded. */
  main: HTMLElement;
  index: SnapshotIndex | null;
  /** Raw snapshot as fetched; views get a copy filtered by the hidden-files set. */
  snapshot: Snapshot | null;
  /** Load an analyzed sha (or WORKTREE), render the active view, and write it to the URL hash. */
  load(sha: string): Promise<void>;
  /** Switch views without re-fetching the snapshot. */
  setView(name: ViewName): Promise<void>;
  setStatus(text: string, kind?: 'info' | 'error' | 'busy'): void;
}

export function readHashParam(key: string): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(key);
}

/** Set one hash param (history.replaceState), preserving the others. */
export function writeHashParam(key: string, value: string): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set(key, value);
  const next = `#${params.toString()}`;
  if (window.location.hash !== next) history.replaceState(null, '', next);
}

/** Read `sha` from a `#sha=<sha>` hash (other hash params are preserved by writeHashSha). */
export function readHashSha(): string | null {
  return readHashParam('sha');
}

export function writeHashSha(sha: string): void {
  writeHashParam('sha', sha);
}

export function readHashMode(): ColorMode {
  return readHashParam('mode') === 'churn' ? 'churn' : 'complexity';
}

export type ViewName = 'treemap' | 'graph' | 'map' | 'compare';

export function readHashView(): ViewName {
  const v = readHashParam('view');
  return v === 'graph' || v === 'map' || v === 'compare' ? v : 'treemap';
}

export function readHashEdges(): boolean {
  return readHashParam('edges') !== '0';
}

/** One main-area view. Created lazily; only the active one is rendered. */
interface View {
  el: HTMLElement;
  /** Snapshot last rendered into this view. */
  snap: Snapshot | null;
  render(snap: Snapshot): void;
}

interface TreemapView extends View {
  bar: HTMLElement;
  treemap: Treemap;
  mode: ColorMode;
  snap: Snapshot | null;
  setMode(mode: ColorMode): void;
}

interface ViewHooks {
  onContextMenu(target: HideTarget, ev: MouseEvent): void;
  barExtra(): Node;
}

/** Summary bar (ref, totals, tier badges, color toggle, legend) above the treemap. */
function createTreemapView(el: HTMLElement, hooks: ViewHooks): TreemapView {
  const bar = document.createElement('div');
  bar.className = 'summary-bar';
  const box = document.createElement('div');
  el.replaceChildren(bar, box);
  const view: TreemapView = {
    el,
    bar,
    treemap: createTreemap(box, { onContextMenu: hooks.onContextMenu }),
    mode: readHashMode(),
    snap: null,
    setMode(mode) {
      view.mode = mode;
      writeHashParam('mode', mode);
      view.treemap.setMode(mode);
      if (view.snap) renderSummaryBar(view, view.snap, hooks);
    },
    render(snap) {
      view.snap = snap;
      renderSummaryBar(view, snap, hooks);
      view.treemap.render(snap, view.mode);
    },
  };
  return view;
}

/** The graph view pulls in Cytoscape, so it is loaded on first use. */
async function createGraphPane(el: HTMLElement, hooks: ViewHooks): Promise<View> {
  const { createGraphView } = await import('./graph/view.ts');
  const graph = createGraphView(el, { onContextMenu: hooks.onContextMenu, barExtra: hooks.barExtra });
  const view: View = {
    el,
    snap: null,
    render(snap) {
      view.snap = snap;
      graph.render(snap);
    },
  };
  return view;
}

interface MapView extends View {
  mode: ColorMode;
  edges: boolean;
  setMode(mode: ColorMode): void;
  setShowEdges(on: boolean): void;
}

/**
 * Experimental map: the graph view in boxes mode (files as code-sized, metric-colored boxes) plus
 * the treemap's color toggle and legend and a Show edges checkbox in its summary bar.
 */
async function createMapPane(el: HTMLElement, hooks: ViewHooks): Promise<MapView> {
  const { createGraphView } = await import('./graph/view.ts');
  const showEdges = readHashEdges();
  const toggle = document.createElement('div');
  toggle.className = 'segmented';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Color by');
  const modeButtons = (
    [
      ['complexity', 'Complexity'],
      ['churn', 'Churn'],
    ] as const
  ).map(([mode, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.mode = mode;
    b.addEventListener('click', () => view.mode !== mode && view.setMode(mode));
    toggle.append(b);
    return b;
  });
  const edgesLabel = document.createElement('label');
  edgesLabel.className = 'map-edges';
  const edgesBox = document.createElement('input');
  edgesBox.type = 'checkbox';
  edgesBox.checked = showEdges;
  edgesBox.addEventListener('change', () => view.setShowEdges(edgesBox.checked));
  edgesLabel.append(edgesBox, ' Show edges');
  const legendSlot = document.createElement('span');
  legendSlot.className = 'map-legend';

  function syncControls(): void {
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === view.mode));
    if (view.snap) legendSlot.replaceChildren(createLegend(colorScale(view.snap.files, view.mode), legendLabel(view.mode, view.snap)));
  }

  const graph = createGraphView(el, {
    mode: 'boxes',
    colorMode: readHashMode(),
    showEdges,
    onContextMenu: hooks.onContextMenu,
    barExtra: () => {
      const tools = document.createElement('span');
      tools.className = 'map-tools';
      tools.append(hooks.barExtra(), toggle, edgesLabel, legendSlot);
      syncControls();
      return tools;
    },
  });
  el.classList.add('map');
  const view: MapView = {
    el,
    snap: null,
    mode: readHashMode(),
    edges: showEdges,
    render(snap) {
      view.snap = snap;
      graph.render(snap);
    },
    setMode(mode) {
      view.mode = mode;
      writeHashParam('mode', mode);
      graph.setColorMode(mode);
      syncControls();
    },
    setShowEdges(on) {
      view.edges = on;
      edgesBox.checked = on;
      writeHashParam('edges', on ? '1' : '0');
      graph.setShowEdges(on);
    },
  };
  return view;
}

function createViewSwitch(onPick: (name: ViewName) => void): { el: HTMLElement; set(name: ViewName): void } {
  const el = document.createElement('div');
  el.className = 'segmented view-switch';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'View');
  const buttons = (
    [
      ['treemap', 'Treemap'],
      ['graph', 'Graph'],
      ['map', 'Map'],
      ['compare', 'Compare'],
    ] as const
  ).map(([name, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.view = name;
    b.addEventListener('click', () => onPick(name));
    el.append(b);
    return b;
  });
  return {
    el,
    set(name) {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.view === name));
    },
  };
}

function renderSummaryBar(view: TreemapView, snap: Snapshot, hooks: ViewHooks): void {
  const code = snap.files.reduce((n, f) => n + (f.code ?? 0), 0);
  const ref = document.createElement('strong');
  ref.textContent = snap.ref || snap.sha.slice(0, 7);
  const sha = document.createElement('code');
  sha.textContent = snap.sha.slice(0, 12);
  const totals = document.createElement('span');
  totals.className = 'muted';
  totals.textContent = `${snap.files.length.toLocaleString()} files · ${snap.functions.length.toLocaleString()} functions · ${code.toLocaleString()} code lines`;

  const toggle = document.createElement('div');
  toggle.className = 'segmented';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Color by');
  for (const [mode, label] of [['complexity', 'Complexity'], ['churn', 'Churn']] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(view.mode === mode));
    b.addEventListener('click', () => view.mode !== mode && view.setMode(mode));
    toggle.append(b);
  }
  const legend = createLegend(colorScale(snap.files, view.mode), legendLabel(view.mode, snap));
  view.bar.replaceChildren(ref, sha, totals, hooks.barExtra(), tierBadges(snap.languages), toggle, legend);
}

export async function startApp(root: HTMLElement, source: DataSource): Promise<App> {
  const header = document.createElement('header');
  const title = document.createElement('h1');
  title.textContent = 'codeviz';
  const status = document.createElement('div');
  status.className = 'status';
  let active: ViewName = readHashView();
  const switcher = createViewSwitch((name) => void app.setView(name));
  switcher.set(active);
  header.append(title, switcher.el, status);

  const main = document.createElement('main');
  main.id = 'view';
  main.dataset.view = 'main';
  const placeholder = document.createElement('p');
  placeholder.className = 'muted';
  placeholder.textContent = 'Pick an analyzed ref, or analyze one, from the list.';
  main.append(placeholder);

  let loadSeq = 0;
  let treemapView: TreemapView | null = null;
  let mapView: MapView | null = null;
  const views = new Map<ViewName, Promise<View>>();
  let compare: Promise<CompareView> | null = null;

  // Hidden files and folders, per repo (set up once the index names the repo, before any view is created).
  let store!: HiddenStore;
  let ui!: HiddenUI;
  let hiddenSet = new Set<string>();
  let hiddenVersion = 0;
  const hooks: ViewHooks = {
    onContextMenu: (target, ev) => ui.openMenu(target, ev.clientX, ev.clientY),
    barExtra: () => ui.chip(),
  };
  /** Filtered copy of a snapshot, cached so an unchanged hidden set keeps the same object (no re-render). */
  const filteredCache = new WeakMap<Snapshot, { version: number; snap: Snapshot }>();
  function filtered(snap: Snapshot): Snapshot {
    const hit = filteredCache.get(snap);
    if (hit?.version === hiddenVersion) return hit.snap;
    const out = filterSnapshot(snap, hiddenSet);
    filteredCache.set(snap, { version: hiddenVersion, snap: out });
    return out;
  }

  function newPane(name: ViewName): HTMLElement {
    const el = document.createElement('div');
    el.className = 'view-pane';
    el.dataset.pane = name;
    if (!main.classList.contains('has-view')) {
      main.replaceChildren();
      main.classList.add('has-view');
    }
    main.append(el);
    return el;
  }

  function getView(name: Exclude<ViewName, 'compare'>): Promise<View> {
    let v = views.get(name);
    if (!v) {
      const el = newPane(name);
      v =
        name === 'graph'
          ? createGraphPane(el, hooks)
          : name === 'map'
            ? createMapPane(el, hooks).then((m) => (mapView = m))
            : Promise.resolve((treemapView = createTreemapView(el, hooks)));
      views.set(name, v);
    }
    return v;
  }

  /** The compare view (and Cytoscape) loads on first use. It does not depend on the current snapshot. */
  function getCompare(): Promise<CompareView> {
    compare ??= import('./compare/view.ts').then(({ createCompareView }) => {
      const view = createCompareView(newPane('compare'), {
        source,
        snapshot: (sha) =>
          sha !== WORKTREE && app.snapshot?.sha === sha ? Promise.resolve(app.snapshot) : source.snapshot(sha),
        readParam: readHashParam,
        writeParam: writeHashParam,
        filter: (diff, head) => ({ diff: filterDiff(diff, hiddenSet), head: filtered(head) }),
        onContextMenu: hooks.onContextMenu,
        barExtra: hooks.barExtra,
      });
      if (app.index) view.setIndex(app.index);
      return view;
    });
    return compare;
  }

  function showPane(el: HTMLElement): void {
    for (const pane of main.querySelectorAll<HTMLElement>('.view-pane')) pane.hidden = pane !== el;
  }

  /** Show the active view, rendering it if it has not seen the current snapshot. */
  async function showActive(): Promise<void> {
    const name = active;
    if (name === 'compare') {
      const view = await getCompare();
      if (name !== active) return;
      showPane(view.el);
      view.show();
      return;
    }
    if (!app.snapshot) return;
    const snap = filtered(app.snapshot);
    const view = await getView(name);
    if (name !== active) return;
    showPane(view.el);
    // Treemap and map share the mode= param; catch up with a change made in the other one.
    const mode = readHashMode();
    if (name === 'treemap' && treemapView && treemapView.mode !== mode) treemapView.setMode(mode);
    if (name === 'map' && mapView && mapView.mode !== mode) mapView.setMode(mode);
    if (view.snap !== snap) {
      const t = performance.now();
      view.render(snap);
      main.dataset.renderMs = (performance.now() - t).toFixed(0);
    }
  }

  const app: App = {
    source,
    main,
    index: null,
    snapshot: null,
    picker: createRefPicker({
      source,
      onSelect: (sha) => app.load(sha),
      onIndex: (index) => {
        app.index = index;
        void compare?.then((c) => c.setIndex(index));
      },
    }),
    async setView(name) {
      if (name === active) return;
      active = name;
      switcher.set(name);
      writeHashParam('view', name);
      try {
        await showActive();
      } catch (err) {
        app.setStatus(`Could not show the ${name} view: ${(err as Error).message}`, 'error');
      }
    },
    setStatus(text, kind = 'info') {
      status.textContent = text;
      status.dataset.kind = kind;
    },
    async load(sha) {
      const seq = ++loadSeq;
      app.setStatus(`Loading ${sha.slice(0, 7)}…`, 'busy');
      try {
        const snap = await source.snapshot(sha);
        if (seq !== loadSeq) return;
        app.snapshot = snap;
        app.picker.setSelected(sha);
        writeHashSha(sha);
        await showActive();
        app.setStatus(`${snap.ref || sha.slice(0, 7)} · ${source.kind}`);
      } catch (err) {
        if (seq !== loadSeq) return;
        app.setStatus(`Could not load ${sha.slice(0, 7)}: ${(err as Error).message}`, 'error');
      }
    },
  };

  const body = document.createElement('div');
  body.className = 'body';
  body.append(app.picker.el, main);
  root.replaceChildren(header, body);

  app.setStatus('Loading index…', 'busy');
  try {
    app.index = await source.index();
  } catch (err) {
    app.setStatus(`Could not load snapshot index: ${(err as Error).message}`, 'error');
    placeholder.textContent =
      source.kind === 'api'
        ? 'The codeviz server did not return a snapshot index.'
        : 'No snapshot data found. Run `codeviz serve` (or open an exported site with snapshots/index.json).';
    return app;
  }
  title.textContent = `codeviz · ${app.index.repo}`;
  document.title = `codeviz · ${app.index.repo}`;
  app.picker.setIndex(app.index);
  store = createHiddenStore(app.index.repoId);
  ui = createHiddenUI(store);
  hiddenSet = new Set(store.list());
  store.onChange(() => {
    hiddenSet = new Set(store.list());
    hiddenVersion++;
    // Re-render from the raw data already held; inactive views catch up when shown.
    void compare?.then((c) => c.refresh());
    showActive().catch((err: Error) => app.setStatus(`Could not re-render: ${err.message}`, 'error'));
  });
  app.setStatus(`${app.index.snapshots.length} snapshot(s) · ${source.kind}`);

  const fromHash = readHashSha();
  const initial =
    fromHash && isAnalyzed(app.index, fromHash)
      ? fromHash
      : isAnalyzed(app.index, app.index.head)
        ? app.index.head
        : null;
  if (fromHash && initial !== fromHash) {
    app.setStatus(`${fromHash.slice(0, 7)} from the URL is not analyzed`, 'error');
  }
  const first = active === 'compare' ? showActive() : null;
  if (initial) await app.load(initial);
  await first?.catch((err: Error) => app.setStatus(`Could not show the compare view: ${err.message}`, 'error'));

  window.addEventListener('hashchange', () => {
    const sha = readHashSha();
    if (sha && sha !== app.snapshot?.sha && app.index && isAnalyzed(app.index, sha)) void app.load(sha);
    const mode = readHashMode();
    if (treemapView && mode !== treemapView.mode) treemapView.setMode(mode);
    if (mapView && mode !== mapView.mode) mapView.setMode(mode);
    if (mapView && readHashEdges() !== mapView.edges) mapView.setShowEdges(readHashEdges());
    const view = readHashView();
    if (view === 'compare' && active === 'compare') void showActive();
    else void app.setView(view);
  });
  return app;
}
