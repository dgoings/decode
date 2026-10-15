import type { Flow, FlowNode, ImpactedScreen, PlanStep, TestPlan } from '@codeviz/core';
// Direct file import: the core barrel pulls in node:* modules, planmd.ts is pure and type-only inside.
import { specificScreens } from '@codeviz/core/src/impact.ts';
import { planMarkdown, routeTitle } from '@codeviz/core/src/planmd.ts';
import type { DataSource } from '../data.ts';
import { clipEnd, clipTail, layoutFlow, NODE_H, NODE_W, nodeWhere } from './flow-layout.ts';
import { allSteps, flowWithPath, isWorktreeKey, plural, richParts, screenSteps, stepKey } from './testplan-model.ts';

export interface TestPlanPanel {
  readonly el: HTMLElement;
  /** A new comparison was loaded: forget the plan; it is fetched again when the panel is shown. */
  /** The commits `base`/`head` resolved to, so a branch that moved is fetched again. */
  setTarget(base: string | null, head: string | null, baseSha?: string, headSha?: string): void;
  /** The panel became visible. Fetches the plan for the current target once. */
  activate(): void;
}

const STORE = 'codeviz.testplan.done';

function readDone(): Set<string> {
  try {
    const raw = localStorage.getItem(STORE);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function writeDone(done: Set<string>): void {
  try {
    localStorage.setItem(STORE, JSON.stringify([...done].filter((k) => !isWorktreeKey(k)).slice(-2000)));
  } catch {
    // storage unavailable: checkmarks last for this page view only
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function rich(parent: HTMLElement, text: string): void {
  for (const p of richParts(text)) parent.append(p.code ? el('code', undefined, p.text) : p.text);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const KIND_CLASS: Record<FlowNode['kind'], string> = {
  screen: 'screen',
  element: 'element',
  handler: 'handler',
  call: 'call',
  state: 'state',
  condition: 'state',
  component: 'component',
};

/** The small graph beside a step: what runs or renders, top to bottom, with changed code marked. */
function flowSvg(flow: Flow): SVGSVGElement {
  const lay = layoutFlow(flow);
  const root = svg('svg', { class: 'fl', width: lay.width, height: lay.height, viewBox: `0 0 ${lay.width} ${lay.height}`, role: 'img' });
  root.setAttribute('aria-label', `Flow: ${flow.nodes.map((n) => n.label).join(' to ')}`);
  for (const e of lay.edges) {
    root.append(svg('path', { class: 'fl-edge', d: e.d }));
    const t = lay.nodes.find((n) => n.id === e.to)!;
    const x = t.x + NODE_W / 2;
    root.append(svg('polygon', { class: 'fl-arrow', points: `${x - 4},${t.y - 6} ${x + 4},${t.y - 6} ${x},${t.y}` }));
  }
  for (const n of lay.nodes) {
    const g = svg('g', { class: `fl-node k-${KIND_CLASS[n.kind]}${n.changed ? ' changed' : ''}`, transform: `translate(${n.x},${n.y})` });
    const full = n.file ? `${n.file}${n.line && n.kind !== 'screen' && n.kind !== 'component' ? `:${n.line}` : ''}` : '';
    const where = nodeWhere(n);
    g.append(svg('title', {}, `${n.label}${full ? `\n${full}` : ''}${n.changed ? '\nchanged in this PR' : ''}`));
    g.append(svg('rect', { width: NODE_W, height: NODE_H, rx: 6 }));
    g.append(svg('text', { class: 'fl-title', x: 8, y: where ? 15 : 24 }, clipTail(n.label, 22)));
    if (where) g.append(svg('text', { class: 'fl-sub', x: 8, y: 30 }, clipEnd(where, 28)));
    if (n.changed) g.append(svg('circle', { class: 'fl-dot', cx: NODE_W - 9, cy: 9, r: 4 }));
    root.append(g);
  }
  return root;
}

function legend(): HTMLElement {
  const box = el('div', 'tp-legend muted');
  const item = (cls: string, text: string) => {
    const i = el('span', 'tp-key');
    const sw = el('span', `tp-sw k-${cls}`);
    i.append(sw, text);
    box.append(i);
  };
  item('screen', 'screen');
  item('element', 'what you click or see');
  item('handler', 'handler');
  item('call', 'what it calls');
  item('state', 'data / condition');
  const changed = el('span', 'tp-key');
  changed.append(el('span', 'tp-sw tp-sw-changed'), 'changed in this PR');
  box.append(changed);
  return box;
}

/**
 * "Test plan" panel: which screens a change affects and what to try on each, from `GET /api/testplan`.
 * Items are a checklist; ticks persist per comparison in localStorage.
 */
export function createTestPlanPanel(source: DataSource): TestPlanPanel {
  const root = el('section', 'cmp-panel cmp-plan');
  const head = el('div', 'cmp-panel-head');
  const title = el('h3', undefined, 'Test plan');
  const summary = el('span', 'muted tp-summary');
  const copy = el('button', 'tp-copy', 'Copy as markdown');
  copy.type = 'button';
  copy.hidden = true;
  head.append(title, summary, copy);
  const body = el('div', 'tp-body');
  root.append(head, body);

  let base: string | null = null;
  let headRef: string | null = null;
  let loadedKey: string | null = null;
  let targetKey = '';
  let plan: TestPlan | null = null;
  let seq = 0;
  let nextId = 0;
  const done = readDone();

  function message(text: string, error = false): void {
    summary.textContent = '';
    copy.hidden = true;
    const p = el('p', error ? 'tp-msg tp-error' : 'tp-msg muted', text);
    body.replaceChildren(p);
  }

  function stepRow(step: PlanStep, chain: string[] | undefined, route: string, progress: () => void): HTMLElement {
    const key = stepKey(plan!.base.sha, plan!.head.sha, step);
    const row = el('div', 'tp-step');
    const id = `tp-${++nextId}`;
    const box = el('input');
    box.type = 'checkbox';
    box.id = id;
    box.dataset.key = key;
    box.checked = done.has(key);
    box.addEventListener('change', () => {
      if (box.checked) done.add(key);
      else done.delete(key);
      // The same step can sit under several screens: keep every copy in step.
      for (const other of body.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
        if (other.dataset.key !== key) continue;
        other.checked = box.checked;
        other.closest('.tp-step')?.classList.toggle('tp-done', box.checked);
      }
      writeDone(done);
      progress();
    });
    row.classList.toggle('tp-done', box.checked);

    const main = el('div', 'tp-main');
    const text = el('label', 'tp-text');
    text.htmlFor = id;
    rich(text, step.text);
    main.append(text);
    if (step.how) {
      const how = el('div', 'tp-how muted');
      how.append(el('strong', undefined, 'Setup: '));
      rich(how, step.how);
      main.append(how);
    }
    if (step.checks.length) {
      const ul = el('ul', 'tp-checks');
      for (const c of step.checks) {
        const li = el('li');
        rich(li, c);
        ul.append(li);
      }
      main.append(ul);
    }
    const why = el('div', 'tp-why muted');
    rich(why, `Changed: ${step.why.join('; ')}`);
    main.append(why, el('div', 'tp-where muted', `${step.file}:${step.line}`));

    row.append(box, main);
    if (step.flow.nodes.length) {
      const flow = el('div', 'tp-flow');
      flow.append(flowSvg(flowWithPath(step, chain, route)));
      row.append(flow);
    }
    return row;
  }

  /** Steps of one file, grouped under the part of the screen (area) they belong to. */
  function stepGroups(steps: PlanStep[], chain: (file: string) => string[] | undefined, route: string, progress: () => void): HTMLElement[] {
    const groups: HTMLElement[] = [];
    let current: { area: string; el: HTMLElement } | null = null;
    for (const s of steps) {
      if (!current || current.area !== s.area) {
        const g = el('div', 'tp-area');
        g.append(el('div', 'tp-area-name', s.area));
        current = { area: s.area, el: g };
        groups.push(g);
      }
      current.el.append(stepRow(s, chain(s.file), route, progress));
    }
    return groups;
  }

  function screenEl(p: TestPlan, s: ImpactedScreen, progress: () => void): HTMLElement {
    const sec = el('section', 'tp-screen');
    const h = el('h4');
    h.append(routeTitle(s.entry.route));
    h.append(el('code', 'tp-route', s.entry.route));
    sec.append(h);
    const groups = screenSteps(p, s);
    const chainOf = (file: string) => s.reached.find((r) => r.file === file)?.chain;
    for (const g of groups) for (const node of stepGroups(g.steps, chainOf, s.entry.route, progress)) sec.append(node);
    const silent = s.reached.filter((r) => !r.shared && !p.steps[r.file]?.length);
    if (!groups.length) {
      sec.append(el('p', 'muted tp-note', 'Changed code reaches this screen, but nothing in it maps to a specific control. Open it and check it still works.'));
    }
    const shared = s.reached.filter((r) => r.shared);
    if (shared.length) sec.append(el('p', 'muted tp-note', `Also reaches shared code: ${shared.map((r) => r.file).join(', ')}`));
    const chains = el('details', 'tp-chains');
    chains.append(el('summary', 'muted', `Why this screen (${plural(s.reached.length, 'changed file')})`));
    const list = el('ul');
    for (const r of s.reached) list.append(el('li', undefined, r.chain.join(' → ')));
    chains.append(list);
    if (silent.length && groups.length) {
      chains.append(el('p', 'muted tp-note', `No steps for: ${silent.map((r) => r.file).join(', ')}`));
    }
    sec.append(chains);
    return sec;
  }

  function render(p: TestPlan): void {
    const steps = allSteps(p);
    const screens = specificScreens(p.impact);
    const progress = () => {
      const n = steps.filter((s) => done.has(stepKey(p.base.sha, p.head.sha, s))).length;
      const viaShared = p.impact.screens.length - screens.length;
      summary.textContent = `${plural(screens.length, 'screen')} affected${viaShared ? ` (+${viaShared} through shared code)` : ''} · ${plural(p.changed, 'changed file')} · ${n}/${steps.length} done`;
    };
    progress();
    copy.hidden = false;
    const frag = document.createDocumentFragment();
    if (steps.length) frag.append(legend());
    if (p.entries === 0) {
      const note = el('p', 'tp-msg muted');
      note.append(
        'No screens were detected, so the plan cannot say where to look. Routes are found automatically under ',
        el('code', undefined, 'pages/'),
        ', ',
        el('code', undefined, 'app/**/page.tsx'),
        ' and ',
        el('code', undefined, 'routes/'),
        '. Otherwise restart with ',
        el('code', undefined, "codeviz serve --entry 'src/screens/*.tsx'"),
        '.',
      );
      frag.append(note);
    } else if (!screens.length && !p.impact.shared.length) {
      frag.append(el('p', 'tp-msg muted', 'No screens are affected by this change.'));
    }
    for (const s of screens) frag.append(screenEl(p, s, progress));
    if (p.impact.shared.length) {
      const sec = el('section', 'tp-screen tp-shared');
      sec.append(el('h4', undefined, 'Shared code'));
      sec.append(el('p', 'muted tp-note', 'Used by many screens. Spot-check one or two rather than all of them.'));
      for (const sh of p.impact.shared) {
        sec.append(el('div', 'tp-file-name muted', `${sh.file} (used by ${plural(sh.screens, 'screen')})`));
        for (const node of stepGroups(p.steps[sh.file] ?? [], () => undefined, '', progress)) sec.append(node);
      }
      frag.append(sec);
    }
    if (p.impact.unreached.length) {
      const d = el('details', 'tp-unreached');
      d.append(el('summary', 'muted', `Changed but not reached from any screen (${p.impact.unreached.length})`));
      const ul = el('ul');
      for (const f of p.impact.unreached) ul.append(el('li', undefined, f));
      d.append(ul);
      frag.append(d);
    }
    if (p.ignored > 0) {
      frag.append(el('p', 'muted tp-note', `${plural(p.ignored, 'other changed file')} (docs, styles, assets, removed files) not analyzed.`));
    }
    body.replaceChildren(frag);
  }

  copy.addEventListener('click', () => {
    if (!plan) return;
    void navigator.clipboard.writeText(planMarkdown(plan)).then(
      () => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy as markdown'), 1500);
      },
      () => {
        copy.textContent = 'Copy failed';
        setTimeout(() => (copy.textContent = 'Copy as markdown'), 1500);
      },
    );
  });

  async function load(): Promise<void> {
    if (!base || !headRef) return;
    const key = targetKey;
    if (key === loadedKey) return;
    if (!source.testplan) {
      message('The test plan needs the live server (codeviz serve): it reads source files and runs git, so it is not part of a static export.');
      return;
    }
    loadedKey = key;
    const my = ++seq;
    message('Working out which screens this change affects…');
    try {
      const p = await source.testplan(base, headRef);
      if (my !== seq) return;
      plan = p;
      for (const k of [...done]) if (isWorktreeKey(k)) done.delete(k);
      render(p);
    } catch (err) {
      if (my !== seq) return;
      loadedKey = null;
      plan = null;
      message(`Could not build the test plan: ${(err as Error).message}`, true);
    }
  }

  message('Pick a base and a head to compare.');
  return {
    el: root,
    setTarget(b, h, bs, hs) {
      const key = `${bs ?? b}\n${hs ?? h}`;
      if (b === base && h === headRef && key === targetKey) return;
      base = b;
      headRef = h;
      targetKey = key;
      loadedKey = null;
      plan = null;
      seq++;
      if (!b || !h) message('Pick a base and a head to compare.');
      else message('Open this panel to build the plan.');
    },
    activate() {
      if (headRef === 'WORKTREE') loadedKey = null; // uncommitted work changes under us: always re-read
      void load();
    },
  };
}
