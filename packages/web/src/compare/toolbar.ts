import { WORKTREE, type MergedBranch, type SnapshotIndex } from '../data.ts';

export interface CompareToolbar {
  readonly el: HTMLElement;
  setIndex(index: SnapshotIndex): void;
  /** Fill the "Review a PR" picker; null hides it (static exports have no git to ask). */
  setMerges(list: { baseRef: string | null; merges: MergedBranch[] } | null): void;
  setValue(base: string | null, head: string | null): void;
  setStatus(text: string, kind?: 'info' | 'error' | 'busy'): void;
}

const short = (sha: string) => (sha === WORKTREE ? sha : sha.slice(0, 7));

/** "3 days ago" style age for a unix-seconds time. */
function ago(seconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - seconds);
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'} ago`;
  if (d < 3600) return unit(Math.max(1, Math.round(d / 60)), 'minute');
  if (d < 86400) return unit(Math.round(d / 3600), 'hour');
  if (d < 86400 * 60) return unit(Math.round(d / 86400), 'day');
  return unit(Math.round(d / (86400 * 30)), 'month');
}

export interface PrPick {
  /** A merged branch from the list: its range is already known. */
  merged?: MergedBranch;
  /** A branch or commit typed in: the server works out its range. */
  ref?: string;
}

/**
 * "Review a PR" (a merged branch from the list, or any branch / commit) on top, which compares a
 * branch with where it left main; below it the manual Base / Head selects fed from the snapshot
 * index, with unanalyzed branches and tags listed disabled.
 */
export function createCompareToolbar(
  onChange: (base: string | null, head: string | null) => void,
  onPr: (pick: PrPick) => void,
): CompareToolbar {
  const el = document.createElement('div');
  el.className = 'cmp-toolbar';

  const prRow = document.createElement('form');
  prRow.className = 'cmp-pr';
  prRow.hidden = true;
  const prLabel = document.createElement('span');
  prLabel.className = 'cmp-pr-label';
  prLabel.textContent = 'Review a PR';
  const mergedSelect = document.createElement('select');
  mergedSelect.name = 'merged';
  const orText = document.createElement('span');
  orText.className = 'muted';
  orText.textContent = 'or';
  const refInput = document.createElement('input');
  refInput.name = 'pr-ref';
  refInput.type = 'text';
  refInput.placeholder = 'branch or commit';
  refInput.spellcheck = false;
  refInput.autocomplete = 'off';
  const go = document.createElement('button');
  go.type = 'submit';
  go.textContent = 'Review';
  const prHint = document.createElement('span');
  prHint.className = 'cmp-pr-hint muted';
  prHint.textContent = 'Compares the branch with where it left main, like its PR did. Squash merges show as their one commit.';
  prRow.append(prLabel, mergedSelect, orText, refInput, go, prHint);
  let merges: MergedBranch[] = [];
  mergedSelect.addEventListener('change', () => {
    const m = merges[Number(mergedSelect.value)];
    if (m) onPr({ merged: m });
  });
  prRow.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const ref = refInput.value.trim();
    if (ref) onPr({ ref });
  });

  const manual = document.createElement('div');
  manual.className = 'cmp-manual';
  el.append(prRow, manual);
  const make = (label: string) => {
    const wrap = document.createElement('label');
    wrap.className = 'cmp-pick';
    const text = document.createElement('span');
    text.textContent = label;
    const select = document.createElement('select');
    select.name = label.toLowerCase();
    select.addEventListener('change', () => onChange(base.value || null, head.value || null));
    wrap.append(text, select);
    manual.append(wrap);
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
  manual.append(status);

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
    setMerges(list) {
      prRow.hidden = !list;
      merges = list?.merges ?? [];
      const into = list?.baseRef ? ` into ${list.baseRef}` : '';
      const first = document.createElement('option');
      first.value = '';
      first.textContent = merges.length ? `Recently merged${into}…` : 'No merged branches found';
      mergedSelect.replaceChildren(first);
      mergedSelect.disabled = !merges.length;
      merges.forEach((m, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        const pr = m.pr ? `#${m.pr} ` : '';
        const size = m.kind === 'squash' ? 'squashed' : `${m.commits} commit${m.commits === 1 ? '' : 's'}`;
        o.textContent = `${pr}${m.name} · ${size} · ${ago(m.date)}`;
        mergedSelect.append(o);
      });
    },
    setValue(b, h) {
      want = [b, h];
      render();
      // The merged picker shows a choice only while that exact comparison is on screen.
      const i = merges.findIndex((m) => m.base === b && m.head === h);
      mergedSelect.value = i >= 0 ? String(i) : '';
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
