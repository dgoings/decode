import { WORKTREE, type SnapshotIndex } from '../data.ts';

export interface CompareToolbar {
  readonly el: HTMLElement;
  setIndex(index: SnapshotIndex): void;
  setValue(base: string | null, head: string | null): void;
  setStatus(text: string, kind?: 'info' | 'error' | 'busy'): void;
}

const short = (sha: string) => (sha === WORKTREE ? sha : sha.slice(0, 7));

/** Base / Head selects fed from the snapshot index. Unanalyzed branches and tags are listed disabled. */
export function createCompareToolbar(onChange: (base: string | null, head: string | null) => void): CompareToolbar {
  const el = document.createElement('div');
  el.className = 'cmp-toolbar';
  const make = (label: string) => {
    const wrap = document.createElement('label');
    wrap.className = 'cmp-pick';
    const text = document.createElement('span');
    text.textContent = label;
    const select = document.createElement('select');
    select.name = label.toLowerCase();
    select.addEventListener('change', () => onChange(base.value || null, head.value || null));
    wrap.append(text, select);
    el.append(wrap);
    return select;
  };
  const base = make('Base');
  const arrow = document.createElement('span');
  arrow.className = 'muted';
  arrow.textContent = '→';
  base.parentElement!.after(arrow);
  const head = make('Head');
  const status = document.createElement('span');
  status.className = 'cmp-status';
  el.append(status);

  let index: SnapshotIndex | null = null;
  let want: [string | null, string | null] = [null, null];

  function option(value: string, label: string, disabled = false): HTMLOptionElement {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.disabled = disabled;
    return o;
  }

  function fill(select: HTMLSelectElement, isHead: boolean, value: string | null): void {
    select.replaceChildren(option('', 'pick a ref…'));
    if (!index) return;
    const known = new Set<string>();
    const analyzed = document.createElement('optgroup');
    analyzed.label = 'Analyzed';
    if (isHead) {
      analyzed.append(option(WORKTREE, `${WORKTREE} (uncommitted)`));
      known.add(WORKTREE);
    }
    for (const s of [...index.snapshots].sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt))) {
      const ref = s.ref && s.ref !== s.sha ? `${s.ref} · ` : '';
      analyzed.append(option(s.sha, `${ref}${short(s.sha)}`));
      known.add(s.sha);
    }
    select.append(analyzed);
    const pending = index.refs.filter((r) => !known.has(r.sha));
    if (pending.length) {
      const g = document.createElement('optgroup');
      g.label = 'Not analyzed (analyze from the list)';
      for (const r of pending) g.append(option(r.name, `${r.name} · ${short(r.sha)} (not analyzed)`, true));
      select.append(g);
    }
    if (value && !known.has(value)) select.append(option(value, `${short(value)} (from URL)`));
    select.value = value ?? '';
  }

  const render = () => {
    fill(base, false, want[0]);
    fill(head, true, want[1]);
  };

  return {
    el,
    setIndex(next) {
      index = next;
      render();
    },
    setValue(b, h) {
      want = [b, h];
      render();
    },
    setStatus(text, kind = 'info') {
      status.replaceChildren();
      if (kind === 'busy') {
        const spin = document.createElement('span');
        spin.className = 'spinner';
        status.append(spin, ' ');
      }
      status.append(text);
      status.dataset.kind = kind;
    },
  };
}
