import { WORKTREE, type DataSource, type LanguageTier, type SnapshotIndex } from './data.ts';

export interface RefPickerOptions {
  source: DataSource;
  /** Called with an analyzed sha (or WORKTREE) once it is ready to load. */
  onSelect(sha: string): Promise<void> | void;
  /** Called whenever the picker re-fetches the index (after an analysis). */
  onIndex?(index: SnapshotIndex): void;
}

interface Entry {
  key: string;
  label: string;
  detail: string;
  /** What to POST to /api/analyze when unanalyzed. */
  ref: string;
  /** Sha to load when analyzed. */
  sha: string;
  analyzed: boolean;
  languages?: Record<string, LanguageTier>;
}

export interface RefPicker {
  readonly el: HTMLElement;
  setIndex(index: SnapshotIndex): void;
  setSelected(sha: string | null): void;
}

// Mirrors isNamedRef in @codeviz/core (the core barrel pulls node:zlib, so the web bundle can't import it).
const isNamedRef = (ref: string, sha: string) => ref !== '' && ref !== 'HEAD' && !/[~^@]/.test(ref) && !sha.startsWith(ref);
const short = (sha: string) => (sha === WORKTREE ? sha : sha.slice(0, 7));

export function tierBadges(languages: Record<string, LanguageTier>): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'badges';
  for (const [lang, tier] of Object.entries(languages).sort()) {
    const b = document.createElement('span');
    b.className = `badge tier-${tier}`;
    b.textContent = lang;
    b.title = `${lang}: ${tier}`;
    wrap.append(b);
  }
  return wrap;
}

/**
 * The analyzed sha that `ref` already names, so typing one costs no analysis: a branch or tag at an
 * analyzed sha, or a sha (or unambiguous prefix) with a snapshot. Null means "ask the server".
 */
export function findAnalyzed(index: SnapshotIndex, ref: string): string | null {
  if (ref === WORKTREE) return index.worktree ? WORKTREE : null;
  const shas = new Set(index.snapshots.map((s) => s.sha));
  const named = index.refs.find((r) => r.name === ref);
  if (named) return shas.has(named.sha) ? named.sha : null;
  if (!/^[0-9a-f]{4,40}$/i.test(ref)) return null;
  const lower = ref.toLowerCase();
  const hits = [...shas].filter((sha) => sha.startsWith(lower));
  return hits.length === 1 ? hits[0]! : null;
}

function groups(index: SnapshotIndex): Array<[string, Entry[]]> {
  const bySha = new Map(index.snapshots.map((s) => [s.sha, s]));
  // Snapshots labelled HEAD or a sha (older cache entries) borrow a branch or tag name at that sha.
  const label = (ref: string, sha: string) =>
    isNamedRef(ref, sha) ? ref : (index.refs.find((r) => r.sha === sha)?.name ?? short(sha));
  const worktree: Entry = {
    key: 'wt',
    label: WORKTREE,
    detail: 'uncommitted changes',
    ref: WORKTREE,
    sha: WORKTREE,
    analyzed: index.worktree !== null,
  };
  const analyzed: Entry[] = [...index.snapshots]
    .sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt))
    .map((s) => ({
      key: `s:${s.sha}`,
      label: label(s.ref, s.sha),
      detail: `${short(s.sha)} · ${new Date(s.analyzedAt).toLocaleString()}`,
      ref: s.sha,
      sha: s.sha,
      analyzed: true,
      languages: s.languages,
    }));
  const fromRef = (kind: 'branch' | 'tag'): Entry[] =>
    index.refs
      .filter((r) => r.kind === kind)
      .map((r) => {
        const snap = bySha.get(r.sha);
        return {
          key: `${kind}:${r.name}`,
          label: r.name,
          detail: short(r.sha) + (r.sha === index.head ? ' · HEAD' : ''),
          ref: r.name,
          sha: r.sha,
          analyzed: !!snap,
          languages: snap?.languages,
        };
      });
  return [
    ['Working tree', [worktree]],
    ['Analyzed', analyzed],
    ['Branches', fromRef('branch')],
    ['Tags', fromRef('tag')],
  ];
}

/** Error key for the "any ref" form; no entry can collide with it (entry keys carry a `:` or are `wt`). */
const FIND_KEY = 'find';

export function createRefPicker(opts: RefPickerOptions): RefPicker {
  const el = document.createElement('nav');
  el.className = 'refpicker';
  // The form lives outside the re-rendered list so typing survives a render.
  const lists = document.createElement('div');
  let index: SnapshotIndex | null = null;
  let selected: string | null = null;
  let busyKey: string | null = null;
  const errors = new Map<string, string>();

  /** Analyze `ref` through the server, then select the sha it resolved to. False means it failed. */
  async function analyzeAndSelect(key: string, ref: string): Promise<boolean> {
    if (!opts.source.analyze) return false;
    busyKey = key;
    render();
    try {
      const { sha } = await opts.source.analyze(ref);
      const next = await opts.source.index();
      opts.onIndex?.(next);
      index = next;
      busyKey = null;
      render();
      await opts.onSelect(sha);
      return true;
    } catch (err) {
      errors.set(key, (err as Error).message);
      busyKey = null;
      render();
      return false;
    }
  }

  async function choose(entry: Entry): Promise<void> {
    if (busyKey) return;
    errors.delete(entry.key);
    if (entry.analyzed) {
      await opts.onSelect(entry.sha);
      return;
    }
    await analyzeAndSelect(entry.key, entry.ref);
  }

  const find = document.createElement('form');
  find.className = 'ref-find';
  const findInput = document.createElement('input');
  findInput.type = 'text';
  findInput.name = 'ref';
  findInput.placeholder = 'any ref: sha, v1.2.0, HEAD~50';
  findInput.autocomplete = 'off';
  findInput.spellcheck = false;
  const findButton = document.createElement('button');
  findButton.type = 'submit';
  findButton.textContent = 'Analyze';
  const findNote = document.createElement('span');
  findNote.className = 'ref-note';
  const findError = document.createElement('p');
  findError.className = 'error';
  find.append(findInput, findButton, findNote, findError);

  /** Load the typed ref, analyzing it first unless a snapshot for it is already cached. */
  async function submitFind(): Promise<void> {
    if (busyKey) return;
    const ref = findInput.value.trim();
    errors.delete(FIND_KEY);
    renderFind();
    if (ref === '') return;
    const hit = index ? findAnalyzed(index, ref) : null;
    if (hit) {
      findInput.value = '';
      render();
      await opts.onSelect(hit);
      return;
    }
    if (await analyzeAndSelect(FIND_KEY, ref)) {
      findInput.value = '';
      renderFind();
    }
  }

  find.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submitFind();
  });

  function renderFind(): void {
    const busy = busyKey === FIND_KEY;
    find.hidden = !opts.source.analyze;
    findInput.disabled = busy;
    findButton.disabled = busyKey !== null;
    findNote.hidden = !busy;
    findNote.innerHTML = busy ? '<span class="spinner"></span> analyzing…' : '';
    const message = errors.get(FIND_KEY);
    findError.hidden = message === undefined;
    findError.textContent = message ?? '';
  }

  function renderEntry(entry: Entry): HTMLElement {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ref';
    if (!entry.analyzed) btn.classList.add('unanalyzed');
    if (entry.analyzed && entry.sha === selected) btn.classList.add('selected');
    const canAnalyze = entry.analyzed || !!opts.source.analyze;
    btn.disabled = !canAnalyze || (busyKey !== null && busyKey !== entry.key);

    const name = document.createElement('span');
    name.className = 'ref-name';
    name.textContent = entry.label;
    const detail = document.createElement('span');
    detail.className = 'ref-detail';
    detail.textContent = entry.detail;
    btn.append(name);
    if (entry.analyzed && entry.languages) btn.append(tierBadges(entry.languages));
    if (!entry.analyzed) {
      const note = document.createElement('span');
      note.className = 'ref-note';
      if (busyKey === entry.key) {
        note.innerHTML = '<span class="spinner"></span> analyzing…';
      } else {
        note.textContent = 'not analyzed';
      }
      btn.append(note);
    }
    btn.append(detail);
    btn.addEventListener('click', () => void choose(entry));
    li.append(btn);

    const error = errors.get(entry.key);
    if (error) {
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = error;
      li.append(p);
    }
    return li;
  }

  function render(): void {
    renderFind();
    lists.replaceChildren();
    if (!index) return;
    for (const [title, entries] of groups(index)) {
      if (!entries.length) continue;
      const section = document.createElement('section');
      const h = document.createElement('h2');
      h.textContent = title;
      const ul = document.createElement('ul');
      ul.append(...entries.map(renderEntry));
      section.append(h, ul);
      lists.append(section);
    }
  }

  el.append(find, lists);
  renderFind();

  return {
    el,
    setIndex(next) {
      index = next;
      render();
    },
    setSelected(sha) {
      selected = sha;
      render();
    },
  };
}
