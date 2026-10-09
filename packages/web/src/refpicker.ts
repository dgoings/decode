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

export function createRefPicker(opts: RefPickerOptions): RefPicker {
  const el = document.createElement('nav');
  el.className = 'refpicker';
  let index: SnapshotIndex | null = null;
  let selected: string | null = null;
  let busyKey: string | null = null;
  const errors = new Map<string, string>();

  async function choose(entry: Entry): Promise<void> {
    if (busyKey) return;
    errors.delete(entry.key);
    if (entry.analyzed) {
      await opts.onSelect(entry.sha);
      return;
    }
    if (!opts.source.analyze) return;
    busyKey = entry.key;
    render();
    try {
      const { sha } = await opts.source.analyze(entry.ref);
      const next = await opts.source.index();
      opts.onIndex?.(next);
      index = next;
      busyKey = null;
      render();
      await opts.onSelect(sha);
    } catch (err) {
      errors.set(entry.key, (err as Error).message);
      busyKey = null;
      render();
    }
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
    el.replaceChildren();
    if (!index) return;
    for (const [title, entries] of groups(index)) {
      if (!entries.length) continue;
      const section = document.createElement('section');
      const h = document.createElement('h2');
      h.textContent = title;
      const ul = document.createElement('ul');
      ul.append(...entries.map(renderEntry));
      section.append(h, ul);
      el.append(section);
    }
  }

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
