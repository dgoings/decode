import { functionAt, type UiCondition, type UiElement, type UiFile, type UiSpan } from './jsx.ts';

/** 1-based inclusive line range on the head side of a diff. */
export interface LineRange {
  start: number;
  end: number;
}

export type TouchReason =
  /** The element's own markup (tags, attributes, text) changed. */
  | { kind: 'markup' }
  /** A function passed to one of its event props changed. */
  | { kind: 'handler'; name: string; event?: string }
  /** The condition deciding whether it renders changed. */
  | { kind: 'condition'; condition: UiCondition };

export interface TouchedElement {
  element: UiElement;
  reasons: TouchReason[];
}

export interface TouchedUi {
  elements: TouchedElement[];
  /** Components with changed lines (logic, hooks, styling: whatever the elements above do not cover). */
  components: UiSpan[];
}

const overlaps = (a: LineRange, start: number, end: number): boolean => a.start <= end && start <= a.end;
/** Whether any range overlaps lines `start..end`. */
export const hit = (ranges: LineRange[], start: number, end: number): boolean => ranges.some((r) => overlaps(r, start, end));

/** Which parts of a file's UI the changed line ranges touch. */
export function touchedUi(ui: UiFile, ranges: LineRange[]): TouchedUi {
  const elements: TouchedElement[] = [];
  for (const element of ui.elements) {
    const reasons: TouchReason[] = [];
    if (element.own.some(([s, e]) => hit(ranges, s, e))) reasons.push({ kind: 'markup' });
    for (const { event, name } of element.refs) {
      const fn = functionAt(ui, name, element.own[0]![0]);
      if (fn && hit(ranges, fn.line, fn.endLine)) reasons.push({ kind: 'handler', name, event });
    }
    for (const condition of element.conditions) {
      // A condition on the element's own lines (`{error && <p>x</p>}`) cannot be told apart from its
      // markup at line granularity, so the markup reason (which names the state) already covers it.
      const sameLines = element.own.some(([s, e]) => s <= condition.line && condition.endLine <= e);
      if (!sameLines && hit(ranges, condition.line, condition.endLine)) reasons.push({ kind: 'condition', condition });
    }
    if (reasons.length) elements.push({ element, reasons });
  }
  return { elements, components: ui.components.filter((c) => hit(ranges, c.line, c.endLine)) };
}

/** A path from a diff header: trailing tab dropped, git's C-style quoting undone. */
function unquote(raw: string): string {
  const p = raw.replace(/\t.*$/, '');
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(["\\])/g, '$1') : p;
}

/** The path in a `--- ` / `+++ ` header without its `a/` or `b/` prefix; null for `/dev/null`. */
function diffPath(raw: string, prefix: 'a' | 'b'): string | null {
  const p = unquote(raw);
  return p === '/dev/null' ? null : p.replace(new RegExp(`^${prefix}/`), '');
}

export interface ParsedDiff {
  /** Head-side changed line ranges per file. A pure deletion (`+n,0`) is a point `n.5` between lines, so only code spanning it counts. */
  ranges: Map<string, LineRange[]>;
  /** Files the diff removes. */
  deleted: string[];
  /** New paths of renamed files (they may have no hunks). */
  renamed: string[];
}

/** Parse `git diff -U0 -M` output. */
export function parseDiff(diff: string): ParsedDiff {
  const out: ParsedDiff = { ranges: new Map(), deleted: [], renamed: [] };
  let file: string | null = null;
  let oldFile: string | null = null;
  // Lines of the current hunk still to read. Inside a hunk, an added line such as `++ x` looks like a `+++ ` header.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-')) oldLeft--;
      else if (line.startsWith('+')) newLeft--;
      continue;
    }
    if (line.startsWith('rename to ')) out.renamed.push(unquote(line.slice('rename to '.length)));
    else if (line.startsWith('--- ')) oldFile = diffPath(line.slice(4), 'a');
    else if (line.startsWith('+++ ')) {
      file = diffPath(line.slice(4), 'b');
      if (file && !out.ranges.has(file)) out.ranges.set(file, []);
      else if (!file && oldFile) out.deleted.push(oldFile);
    } else if (file && line.startsWith('@@')) {
      const m = /-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(line);
      if (!m) continue;
      const start = Number(m[3]);
      const count = m[4] === undefined ? 1 : Number(m[4]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = count;
      out.ranges.get(file)!.push(count === 0 ? { start: start + 0.5, end: start + 0.5 } : { start, end: start + count - 1 });
    }
  }
  return out;
}

/** Just the head-side ranges of `parseDiff`. */
export const parseChangedRanges = (diff: string): Map<string, LineRange[]> => parseDiff(diff).ranges;
