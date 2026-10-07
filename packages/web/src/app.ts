import { isAnalyzed, type DataSource, type Snapshot, type SnapshotIndex } from './data.ts';
import { createRefPicker, tierBadges, type RefPicker } from './refpicker.ts';

export interface App {
  source: DataSource;
  picker: RefPicker;
  /** Main content area. The treemap (next story) renders here. */
  main: HTMLElement;
  index: SnapshotIndex | null;
  snapshot: Snapshot | null;
  /** Load an analyzed sha (or WORKTREE), render it, and write it to the URL hash. */
  load(sha: string): Promise<void>;
  setStatus(text: string, kind?: 'info' | 'error' | 'busy'): void;
}

/** Read `sha` from a `#sha=<sha>` hash (other hash params are preserved by writeHashSha). */
export function readHashSha(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get('sha');
}

export function writeHashSha(sha: string): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set('sha', sha);
  const next = `#${params.toString()}`;
  if (window.location.hash !== next) history.replaceState(null, '', next);
}

/** Placeholder main view: snapshot summary. Replaced by the treemap in the next story. */
export function renderSummary(main: HTMLElement, snap: Snapshot): void {
  const code = snap.files.reduce((n, f) => n + (f.code ?? 0), 0);
  const section = document.createElement('section');
  section.className = 'summary';
  const h = document.createElement('h2');
  h.textContent = `${snap.ref || snap.sha.slice(0, 7)} `;
  const sha = document.createElement('code');
  sha.textContent = snap.sha.slice(0, 12);
  h.append(sha);
  const dl = document.createElement('dl');
  const row = (k: string, v: string | Node) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.append(v);
    dl.append(dt, dd);
  };
  row('Files', snap.files.length.toLocaleString());
  row('Functions', snap.functions.length.toLocaleString());
  row('Code lines', code.toLocaleString());
  row('Languages', tierBadges(snap.languages));
  row('Analyzed', new Date(snap.analyzedAt).toLocaleString());
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Treemap goes here (next story).';
  section.append(h, dl, note);
  main.replaceChildren(section);
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
        renderSummary(main, snap);
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
  });
  return app;
}
