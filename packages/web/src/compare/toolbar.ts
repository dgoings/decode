import { WORKTREE, type CommitEntry, type DataSource, type SnapshotIndex } from '../data.ts';
import { baseIsNewer, COMMIT_LIMIT, commitLabel, defaultPair, pairInBranch } from './history.ts';

/** `branches`: tip against tip. `history`: two commits of one branch. Hash param `cmp`. */
export type CompareMode = 'branches' | 'history';

export interface CompareToolbarOptions {
  source: DataSource;
  /** Ask the view to compare this pair. */
  onChange(base: string | null, head: string | null): void;
  readParam(key: string): string | null;
  writeParam(key: string, value: string): void;
}

export interface CompareToolbar {
  readonly el: HTMLElement;
  setIndex(index: SnapshotIndex): void;
  setValue(base: string | null, head: string | null): void;
  setStatus(text: string, kind?: 'info' | 'error' | 'busy'): void;
}

const short = (sha: string) => (sha === WORKTREE ? sha : sha.slice(0, 7));

/** Both sides must be set, and `WORKTREE` is never a valid base, so a swap would be refused. */
export function canSwap(base: string | null, head: string | null): boolean {
  return !!base && !!head && base !== WORKTREE && head !== WORKTREE;
}
const readMode = (v: string | null): CompareMode => (v === 'history' ? 'history' : 'branches');

const MODES: Array<[CompareMode, string, string]> = [
  ['branches', 'Branches', 'Compare the tip of one branch or tag with another'],
  ['history', 'History', 'Compare two commits inside one branch'],
];

/**
 * Mode switch plus Base / Head selects. The Branches mode lists refs from the snapshot index. The
 * History mode adds a Branch select and lists that branch's commits, which needs `source.commits`
 * (an api source only, because a static export cannot analyze a commit it does not hold).
 */
export function createCompareToolbar(opts: CompareToolbarOptions): CompareToolbar {
  const { source, onChange, readParam, writeParam } = opts;
  const el = document.createElement('div');
  el.className = 'cmp-toolbar';

  const modeSwitch = document.createElement('div');
  modeSwitch.className = 'segmented cmp-mode';
  const modeButtons = new Map<CompareMode, HTMLButtonElement>();
  for (const [m, label, title] of MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', () => setMode(m));
    modeButtons.set(m, button);
    modeSwitch.append(button);
  }
  el.append(modeSwitch);

  const make = (label: string, cls?: string) => {
    const wrap = document.createElement('label');
    wrap.className = cls ? `cmp-pick ${cls}` : 'cmp-pick';
    const text = document.createElement('span');
    text.textContent = label;
    const select = document.createElement('select');
    select.name = label.toLowerCase();
    wrap.append(text, select);
    el.append(wrap);
    return { wrap, select };
  };
  const branch = make('Branch', 'cmp-branch');
  const base = make('Base');
  const swap = document.createElement('button');
  swap.type = 'button';
  swap.className = 'cmp-swap';
  swap.textContent = '⇄';
  swap.setAttribute('aria-label', 'Swap the base and the head');
  swap.addEventListener('click', () => {
    const [b, h] = want;
    if (!canSwap(b, h)) return;
    want = [h, b];
    render();
    onChange(h, b);
  });
  base.wrap.after(swap);
  const head = make('Head');
  const note = document.createElement('span');
  note.className = 'cmp-note';
  const status = document.createElement('span');
  status.className = 'cmp-status';
  el.append(note, status);

  let index: SnapshotIndex | null = null;
  let mode: CompareMode = 'branches';
  let commits: CommitEntry[] = [];
  /** The branch whose commits `commits` holds; null while none is loaded. */
  let loadedBranch: string | null = null;
  let want: [string | null, string | null] = [null, null];
  let loadSeq = 0;

  const pick = () => {
    want = [base.select.value || null, head.select.value || null];
    renderNote();
    onChange(want[0], want[1]);
  };
  base.select.addEventListener('change', pick);
  head.select.addEventListener('change', pick);
  branch.select.addEventListener('change', () => void loadBranch(branch.select.value));

  function option(value: string, label: string, disabled = false): HTMLOptionElement {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.disabled = disabled;
    return o;
  }

  /** The branch the History mode starts on: the one in the hash, the one at HEAD, else the first. */
  function currentBranch(): string | null {
    const branches = index?.refs.filter((r) => r.kind === 'branch') ?? [];
    const wanted = readParam('branch');
    if (wanted && branches.some((b) => b.name === wanted)) return wanted;
    return branches.find((b) => b.sha === index?.head)?.name ?? branches[0]?.name ?? null;
  }

  function setMode(next: CompareMode): void {
    if (next === mode || !source.commits) return;
    mode = next;
    writeParam('cmp', next);
    render();
    // Switching back to Branches keeps the shown comparison: the pair is still valid, only listed differently.
    if (next === 'history') void loadBranch(currentBranch());
  }

  /** Read a branch's commits, fill both selects, and compare its newest pair unless the hash holds one. */
  async function loadBranch(name: string | null): Promise<void> {
    if (!name || !source.commits) return;
    writeParam('branch', name);
    const my = ++loadSeq;
    const reload = name !== loadedBranch;
    if (reload) {
      commits = [];
      loadedBranch = name;
      render();
      setStatus(`Reading the history of ${name}…`, 'busy');
      try {
        commits = await source.commits(name, COMMIT_LIMIT);
      } catch (err) {
        if (my !== loadSeq) return;
        loadedBranch = null;
        render();
        setStatus(`Could not read the history of ${name}: ${(err as Error).message}`, 'error');
        return;
      }
      if (my !== loadSeq) return;
      render();
      setStatus('');
    }
    if (pairInBranch(commits, want[0], want[1])) return;
    const pair = defaultPair(commits);
    if (!pair) {
      setStatus(`${name} holds one commit, so there is nothing to compare.`, 'error');
      return;
    }
    want = [pair.base, pair.head];
    render();
    onChange(pair.base, pair.head);
  }

  /** Branches mode: analyzed snapshots first, then refs that no snapshot covers (disabled). */
  function fillRefs(select: HTMLSelectElement, isHead: boolean, value: string | null): void {
    select.disabled = false;
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

  function fillBranches(value: string | null): void {
    branch.select.replaceChildren();
    const branches = index?.refs.filter((r) => r.kind === 'branch') ?? [];
    if (!branches.length) {
      branch.select.append(option('', 'no branches'));
      branch.select.disabled = true;
      return;
    }
    branch.select.disabled = false;
    for (const b of branches) branch.select.append(option(b.name, b.name));
    if (value && !branches.some((b) => b.name === value)) branch.select.append(option(value, value));
    branch.select.value = value ?? '';
  }

  /** History mode: every commit of the loaded branch, newest first, analyzed ones marked. */
  function fillCommits(select: HTMLSelectElement, value: string | null): void {
    select.replaceChildren();
    if (!commits.length) {
      select.append(option('', loadedBranch ? 'reading…' : 'pick a branch…'));
      select.disabled = true;
      select.value = '';
      return;
    }
    select.disabled = false;
    const analyzed = new Set(index?.snapshots.map((s) => s.sha) ?? []);
    for (const c of commits) select.append(option(c.sha, commitLabel(c, analyzed.has(c.sha))));
    if (value && !commits.some((c) => c.sha === value)) {
      select.append(option(value, `${short(value)} (not in this branch)`));
    }
    select.value = value ?? '';
  }

  function renderNote(): void {
    const reversed =
      mode === 'history' && want[0] !== null && want[1] !== null && baseIsNewer(commits, want[0], want[1]);
    note.hidden = !reversed;
    note.textContent = reversed ? 'The base is newer than the head, so the deltas read backwards.' : '';
  }

  function render(): void {
    const canHistory = !!source.commits;
    if (!canHistory) mode = 'branches';
    modeSwitch.hidden = !canHistory;
    for (const [m, button] of modeButtons) button.setAttribute('aria-pressed', String(m === mode));
    branch.wrap.hidden = mode !== 'history';
    swap.disabled = !canSwap(want[0], want[1]);
    swap.title =
      want[1] === WORKTREE
        ? 'WORKTREE can only be the head of a comparison'
        : 'Swap the base and the head';
    if (mode === 'history') {
      fillBranches(loadedBranch ?? currentBranch());
      fillCommits(base.select, want[0]);
      fillCommits(head.select, want[1]);
    } else {
      fillRefs(base.select, false, want[0]);
      fillRefs(head.select, true, want[1]);
    }
    renderNote();
  }

  function setStatus(text: string, kind: 'info' | 'error' | 'busy' = 'info'): void {
    status.replaceChildren();
    if (kind === 'busy') {
      const spin = document.createElement('span');
      spin.className = 'spinner';
      status.append(spin, ' ');
    }
    status.append(text);
    status.dataset.kind = kind;
  }

  return {
    el,
    setIndex(next) {
      index = next;
      render();
    },
    setValue(b, h) {
      want = [b, h];
      const hashMode = source.commits ? readMode(readParam('cmp')) : 'branches';
      if (hashMode !== mode) mode = hashMode;
      render();
      // A hash edit can name another branch, or the History mode before any branch is loaded.
      if (mode === 'history') {
        const name = currentBranch();
        if (name && name !== loadedBranch) void loadBranch(name);
      }
    },
    setStatus,
  };
}
