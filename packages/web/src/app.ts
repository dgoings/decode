import { isAnalyzed, type DataSource, type Snapshot, type SnapshotIndex } from './data.ts';
import { createRefPicker, tierBadges, type RefPicker } from './refpicker.ts';
import { colorScale, createLegend, createTreemap, legendLabel, type ColorMode, type Treemap } from './treemap.ts';

export interface App {
  source: DataSource;
  picker: RefPicker;
  /** Main content area: summary bar + treemap once a snapshot is loaded. */
  main: HTMLElement;
  index: SnapshotIndex | null;
  snapshot: Snapshot | null;
  /** Load an analyzed sha (or WORKTREE), render the treemap, and write it to the URL hash. */
  load(sha: string): Promise<void>;
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

interface TreemapView {
  bar: HTMLElement;
  treemap: Treemap;
  mode: ColorMode;
  snap: Snapshot | null;
  setMode(mode: ColorMode): void;
}

/** Summary bar (ref, totals, tier badges, color toggle, legend) above the treemap. */
function createTreemapView(main: HTMLElement): TreemapView {
  const bar = document.createElement('div');
  bar.className = 'summary-bar';
  const box = document.createElement('div');
  main.classList.add('has-treemap');
  main.replaceChildren(bar, box);
  const view: TreemapView = {
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
  };
  return view;
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
  header.append(title, status);

  const main = document.createElement('main');
  main.id = 'view';
  main.dataset.view = 'main';
  const placeholder = document.createElement('p');
  placeholder.className = 'muted';
  placeholder.textContent = 'Pick an analyzed ref, or analyze one, from the list.';
  main.append(placeholder);

  let loadSeq = 0;
  let view: TreemapView | null = null;
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
        view ??= createTreemapView(main);
        view.snap = snap;
        renderSummaryBar(view, snap);
        view.treemap.render(snap, view.mode);
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
    if (view && mode !== view.mode) view.setMode(mode);
  });
  return app;
}
