import { isAnalyzed, type DataSource, type Snapshot, type SnapshotIndex } from './data.ts';
import { createRefPicker, tierBadges, type RefPicker } from './refpicker.ts';
import { colorScale, createLegend, createTreemap, legendLabel, type ColorMode, type Treemap } from './treemap.ts';

export interface App {
  source: DataSource;
  picker: RefPicker;
  /** Main content area: the active view (summary bar + treemap or graph) once a snapshot is loaded. */
  main: HTMLElement;
  index: SnapshotIndex | null;
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

export type ViewName = 'treemap' | 'graph';

export function readHashView(): ViewName {
  return readHashParam('view') === 'graph' ? 'graph' : 'treemap';
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

/** Summary bar (ref, totals, tier badges, color toggle, legend) above the treemap. */
function createTreemapView(el: HTMLElement): TreemapView {
  const bar = document.createElement('div');
  bar.className = 'summary-bar';
  const box = document.createElement('div');
  el.replaceChildren(bar, box);
  const view: TreemapView = {
    el,
    bar,
    treemap: createTreemap(box),
    mode: readHashMode(),
    snap: null,
    setMode(mode) {
      view.mode = mode;
      writeHashParam('mode', mode);
      view.treemap.setMode(mode);
      if (view.snap) renderSummaryBar(view, view.snap);
    },
    render(snap) {
      view.snap = snap;
      renderSummaryBar(view, snap);
      view.treemap.render(snap, view.mode);
    },
  };
  return view;
}

/** The graph view pulls in Cytoscape, so it is loaded on first use. */
async function createGraphPane(el: HTMLElement): Promise<View> {
  const { createGraphView } = await import('./graph/view.ts');
  const graph = createGraphView(el);
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

function createViewSwitch(onPick: (name: ViewName) => void): { el: HTMLElement; set(name: ViewName): void } {
  const el = document.createElement('div');
  el.className = 'segmented view-switch';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'View');
  const buttons = (
    [
      ['treemap', 'Treemap'],
      ['graph', 'Graph'],
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

function renderSummaryBar(view: TreemapView, snap: Snapshot): void {
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
  view.bar.replaceChildren(ref, sha, totals, tierBadges(snap.languages), toggle, legend);
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
  const views = new Map<ViewName, Promise<View>>();

  function getView(name: ViewName): Promise<View> {
    let v = views.get(name);
    if (!v) {
      const el = document.createElement('div');
      el.className = 'view-pane';
      el.dataset.pane = name;
      if (!views.size) {
        main.replaceChildren();
        main.classList.add('has-view');
      }
      main.append(el);
      v =
        name === 'graph'
          ? createGraphPane(el)
          : Promise.resolve((treemapView = createTreemapView(el)));
      views.set(name, v);
    }
    return v;
  }

  /** Show the active view, rendering it if it has not seen the current snapshot. */
  async function showActive(): Promise<void> {
    const snap = app.snapshot;
    if (!snap) return;
    const name = active;
    const view = await getView(name);
    if (name !== active) return;
    for (const pane of main.querySelectorAll<HTMLElement>('.view-pane')) pane.hidden = pane !== view.el;
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
      onIndex: (index) => (app.index = index),
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
  if (initial) await app.load(initial);

  window.addEventListener('hashchange', () => {
    const sha = readHashSha();
    if (sha && sha !== app.snapshot?.sha && app.index && isAnalyzed(app.index, sha)) void app.load(sha);
    const mode = readHashMode();
    if (treemapView && mode !== treemapView.mode) treemapView.setMode(mode);
    void app.setView(readHashView());
  });
  return app;
}
