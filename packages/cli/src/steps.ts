import { bindingAt, functionAt, hit, type LineRange, type TouchedUi, type UiElement, type UiFile } from '@codeviz/analyzers';
import type { Flow, FlowNode, PlanStep, StepKind } from '@codeviz/core';
import { areaName, conditionPhrase, humanize, outcomeOfCall, sentence, type ConditionContext } from './phrase.ts';

/** Repo lookups the step builder needs; injected so the builder stays pure. */
export interface Resolver {
  /** Repo file an import specifier points at (relative paths and `@/`-style aliases). */
  importFile(from: string, spec: string): string | undefined;
  /** File of a generated-API call (`api.taskTags.create` -> `convex/taskTags.ts`); `segments` are the module path. */
  apiModuleFile(from: string, spec: string, segments: string[]): string | undefined;
  /** Where `name` is declared in `file`, and where its body ends. */
  declSpan(file: string, name: string): { line: number; endLine: number } | undefined;
  /** Whether the diff touches `file`, or lines `from..to` of it. */
  changed(file: string, from?: number, to?: number): boolean;
}

export interface StepInput {
  file: string;
  ui: UiFile;
  touched: TouchedUi;
  ranges: LineRange[];
  /** Changed function names, for files with no UI. */
  fnNames: string[];
  resolver: Resolver;
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (s: string): string => `\u201c${s}\u201d`;
const baseName = (file: string): string => file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
const isNative = (tag: string): boolean => /^[a-z]/.test(tag);

/** What a call in a handler turned out to be. */
interface Callee {
  kind: 'remote' | 'local' | 'setter' | 'notify' | 'navigate';
  name: string;
  /** Short readable form, `taskTags.create`. */
  label: string;
  file?: string;
  line?: number;
  endLine?: number;
}

/** Notification helpers. `message` and `alert` are too common as plain names to assume; bare `alert(...)` is handled below. */
const NOTIFY = /^(toast|notify|notification|snackbar)$/i;
const NETWORK = /^(fetch|axios|ky)$/;
/** Hooks whose argument is the remote function the returned callable invokes (`useMutation(api.x.y)`). */
const CALL_HOOK = /^use(?:Mutation|Action)$|(?:Mutation|Action)$/;
const QUERY_HOOK = /^use(?:Query|SWR|Fetch|Suspense|Infinite|Subscription)|Query$/;

/** `at` is the line the call is written on, to pick the right declaration of a reused name. */
function resolveCall(callee: string, input: StepInput, at: number, depth = 0): Callee | null {
  const { ui, resolver, file } = input;
  const segs = callee.split('.');
  const root = segs[0]!;
  const last = segs[segs.length - 1]!;
  const binding = bindingAt(ui, root, at);
  if (binding?.setter || (!binding && segs.length === 1 && /^set[A-Z]/.test(root))) return { kind: 'setter', name: last, label: callee };
  // Checked before the hook-binding rules: `toast` and `router` usually come from hooks themselves.
  if (NOTIFY.test(root) || (callee === 'alert' && !binding)) return { kind: 'notify', name: last, label: callee };
  if (root === 'navigate' || root === 'redirect' || (/^(router|history)$/.test(root) && /^(push|replace|back)$/.test(last))) {
    return { kind: 'navigate', name: last, label: callee };
  }
  if (binding) {
    // `tags.find(...)` on a query result is data access, not something the user triggers.
    if (QUERY_HOOK.test(binding.call)) return null;
    // `const createTag = useMutation(api.taskTags.create)`: calling createTag calls that function.
    return binding.arg && depth === 0 && CALL_HOOK.test(binding.call) ? resolveCall(binding.arg, input, binding.line, 1) : null;
  }
  const imp = ui.imports[root];
  if (imp) {
    if (/_generated\/api(?:\.[cm]?js)?$/.test(imp.spec) && segs.length >= 3) {
      const target = resolver.apiModuleFile(file, imp.spec, segs.slice(1, -1));
      return { kind: 'remote', name: last, label: segs.slice(1).join('.'), file: target, ...(target ? resolver.declSpan(target, last) : {}) };
    }
    const target = resolver.importFile(file, imp.spec);
    if (target) {
      const name = segs.length > 1 ? last : imp.name === 'default' || imp.name === '*' ? root : imp.name;
      return { kind: 'local', name, label: callee, file: target, ...resolver.declSpan(target, name) };
    }
    return NETWORK.test(root) ? { kind: 'remote', name: last, label: callee } : null;
  }
  if (NETWORK.test(root)) return { kind: 'remote', name: last, label: callee };
  const fn = functionAt(ui, root, at);
  if (fn && segs.length === 1) return { kind: 'local', name: root, label: callee, file, line: fn.line, endLine: fn.endLine };
  return null;
}

/** A handler attached to an element, from an inline function, a named function, or a prop. */
interface Handler {
  event: string;
  label: string;
  line: number;
  endLine: number;
  /** Callee texts with the line each is written on. */
  calls: Array<{ name: string; at: number }>;
  hasTry: boolean;
  /** Set when the handler is a prop of the enclosing component and the parent's handler was followed. */
  via?: { prop: string; parent: string; line: number };
}

function handlersOf(el: UiElement, input: StepInput): Handler[] {
  const { ui } = input;
  const own = el.own[0]![0];
  const out: Handler[] = [];
  for (const event of el.events) {
    const inline = el.inline.find((i) => i.event === event);
    if (inline) {
      out.push({ event, label: event, line: inline.line, endLine: inline.endLine, calls: inline.calls.map((name) => ({ name, at: inline.line })), hasTry: inline.hasTry });
      continue;
    }
    const ref = el.refs.find((r) => r.event === event)?.name;
    if (!ref) continue;
    const fn = functionAt(ui, ref, own);
    if (fn) out.push({ event, label: `${ref}()`, line: fn.line, endLine: fn.endLine, calls: fn.calls.map((name) => ({ name, at: fn.line })), hasTry: fn.hasTry });
    else out.push({ event, label: ref, line: own, endLine: own, calls: [{ name: ref, at: own }], hasTry: false });
  }
  return out.map((h) => followProps(h, el, input));
}

/**
 * `onChange(color)` inside `TagColorPicker`, where `onChange` is one of its props: continue into the
 * handler the same file passes for that prop (`<TagColorPicker onChange={(c) => updateTag(c)} />`).
 */
function followProps(h: Handler, el: UiElement, input: StepInput): Handler {
  const { ui } = input;
  const comp = el.component ? ui.components.find((c) => c.name === el.component) : undefined;
  if (!comp) return h;
  const prop = h.calls.find((c) => comp.props.includes(c.name))?.name;
  if (!prop) return h;
  for (const parent of ui.elements) {
    if (parent.tag !== comp.name) continue;
    const inline = parent.inline.find((i) => i.event === prop);
    const ref = parent.refs.find((r) => r.event === prop)?.name;
    const fn = ref ? functionAt(ui, ref, parent.own[0]![0]) : undefined;
    const calls = inline?.calls ?? fn?.calls;
    if (!calls) continue;
    const at = inline?.line ?? fn?.line ?? parent.own[0]![0];
    return {
      ...h,
      calls: [...h.calls.filter((c) => c.name !== prop), ...calls.map((name) => ({ name, at }))],
      hasTry: h.hasTry || (inline?.hasTry ?? fn?.hasTry ?? false),
      via: { prop, parent: parent.component ?? comp.name, line: inline?.line ?? fn?.line ?? parent.own[0]![0] },
    };
  }
  return h;
}

/** What to look for after the action, from what the handler does. */
function checksFor(callees: Callee[], hasTry: boolean): string[] {
  const out: string[] = [];
  const add = (s: string) => out.includes(s) || out.push(s);
  for (const c of callees) {
    if (c.kind === 'remote' || c.kind === 'local') {
      const o = outcomeOfCall(c.name);
      if (o) add(o);
      else if (c.kind === 'remote') add(`The request to \`${c.label}\` goes through`);
    }
  }
  if (callees.some((c) => c.kind === 'notify')) add('A notification appears');
  if (callees.some((c) => c.kind === 'navigate')) add('You are taken to the right page');
  if (callees.some((c) => c.kind === 'setter')) add('The screen updates to match');
  if (hasTry) add('Also try it when it fails (for example, go offline) and check the error is handled');
  return out.length ? out.slice(0, 4) : ['It still does what it did before'];
}

const elementName = (el: UiElement): string => {
  const kind = isNative(el.tag) ? ({ button: 'button', link: 'link', input: 'field', form: 'form', overlay: 'dialog', element: /^(p|span|div|h[1-6]|li|label|strong|em|small)$/.test(el.tag) ? 'text' : el.tag } as const)[el.kind] : humanize(el.tag);
  return el.label ? `${quote(short(el.label, 20))} ${kind}` : kind === el.tag ? `<${el.tag}>` : kind;
};

/** The imperative sentence for what to do with an element. */
function actionText(el: UiElement, h: Handler | undefined, area: string): string {
  const named = (h && (h.via ? humanize(h.via.prop) : humanize(h.label.replace(/\(\)$/, '')))) || undefined;
  if (!isNative(el.tag) && el.kind === 'element' && h) {
    // A generic custom component: `onAdd` plus an `addLabel="Add tag"` prop is the "Add tag" button inside it.
    const verb = h.event.replace(/^on/, '');
    const labelProp = el.props[verb[0]!.toLowerCase() + verb.slice(1) + 'Label'];
    if (labelProp) return `Click ${quote(labelProp)}`;
    return `In the ${humanize(el.tag)}, ${humanize(h.event)}${/^(add|remove|delete|rename|edit|select|toggle|change|save|cancel|confirm|close|open|submit)$/.test(humanize(h.event)) ? ' an item' : ''}`;
  }
  const lbl = el.label;
  switch (el.kind) {
    case 'button':
      if (el.repeated) return lbl ? `Click any of the ${quote(lbl)} buttons` : `Click any of the buttons in the ${area.toLowerCase()}`;
      if (lbl) return `Click ${quote(lbl)}`;
      return named && !/^(click|change|submit)$/.test(named) ? `Click the ${quote(sentence(named))} button` : `Click the button in the ${area.toLowerCase()}`;
    case 'link':
      return lbl ? `Click the ${quote(lbl)} link` : `Click the link in the ${area.toLowerCase()}`;
    case 'input':
      return lbl ? `Fill in the ${quote(lbl)} field` : `Fill in the field in the ${area.toLowerCase()}`;
    case 'form':
      return `Fill in and submit the ${lbl ? `${quote(lbl)} ` : ''}form in the ${area.toLowerCase()}`;
    case 'overlay':
      return lbl ? `Open the ${quote(lbl)} ${/menu/i.test(el.tag) ? 'menu' : 'dialog'}` : `Open the ${humanize(el.tag)}`;
    default:
      return el.events.length ? `Click the ${lbl ? quote(lbl) : humanize(el.tag)}` : `Look at the ${lbl ? quote(lbl) : humanize(el.tag)}`;
  }
}

const stepKindOf = (el: UiElement): StepKind =>
  el.kind === 'input' ? 'enter' : el.kind === 'form' ? 'submit' : el.kind === 'overlay' ? 'open' : el.events.length || el.kind !== 'element' ? 'click' : 'view';

/** Whether the diff touches a resolved callee: its own lines when known, else its file. */
const calleeChanged = (c: Callee, r: Resolver): boolean => (c.file ? r.changed(c.file, c.line, c.endLine) : false);

class FlowBuilder {
  nodes: FlowNode[] = [];
  edges: Array<[string, string]> = [];
  add(node: Omit<FlowNode, 'id'>): string {
    const dup = this.nodes.find((n) => n.kind === node.kind && n.label === node.label && n.file === node.file && n.line === node.line);
    if (dup) return dup.id;
    const id = `n${this.nodes.length}`;
    this.nodes.push({ id, ...node });
    return id;
  }
  link(from: string, to: string): void {
    if (from !== to && !this.edges.some(([a, b]) => a === from && b === to)) this.edges.push([from, to]);
  }
  build(): Flow {
    return { nodes: this.nodes, edges: this.edges };
  }
}

function conditionContext(ui: UiFile, line: number): ConditionContext {
  return { isQuery: (n) => QUERY_HOOK.test(bindingAt(ui, n, line)?.call ?? '') };
}

/**
 * Nodes for how a condition gets its value: the backend call behind a query hook, the state it
 * fills, then the condition itself. Returns the id of the last node (the condition).
 */
function conditionChain(fb: FlowBuilder, text: string, cond: { line: number; endLine: number }, input: StepInput, changed: boolean): string {
  const { ui, file, resolver } = input;
  let prev: string | undefined;
  const root = /^!?\s*\(?\s*([A-Za-z_$][\w$]*)/.exec(text)?.[1];
  const binding = root ? bindingAt(ui, root, cond.line) : undefined;
  if (root && binding) {
    const callee = binding.arg ? resolveCall(binding.arg, input, binding.line, 1) : null;
    if (callee) prev = fb.add({ kind: 'call', label: callee.label, file: callee.file, line: callee.line, changed: calleeChanged(callee, resolver) });
    const state = fb.add({ kind: 'state', label: `${root} (${binding.call})`, file, line: binding.line, changed: input.ranges.length ? hit(input.ranges, binding.line, binding.line) : false });
    if (prev) fb.link(prev, state);
    prev = state;
  }
  const c = fb.add({ kind: 'condition', label: short(text, 28), file, line: cond.line, changed });
  if (prev) fb.link(prev, c);
  return c;
}

/**
 * A component defined in this same file is not a control itself: the user acts on the elements
 * inside it that call the props passed to it (`<Picker onChange={...} />` -> the swatch buttons).
 */
function actedOn(usage: UiElement, input: StepInput): UiElement[] {
  const { ui } = input;
  if (isNative(usage.tag) || !ui.components.some((c) => c.name === usage.tag)) return [usage];
  const fires = (e: UiElement): boolean =>
    e.component === usage.tag && (e.inline.some((i) => i.calls.some((c) => usage.events.includes(c))) || e.refs.some((r) => functionAt(ui, r.name, e.own[0]![0])?.calls.some((c) => usage.events.includes(c))));
  const inside = ui.elements.filter(fires);
  return inside.length ? inside : [usage];
}

/** Steps for the touched parts of one file. */
export function buildSteps(input: StepInput): PlanStep[] {
  const { file, ui, touched, ranges, fnNames, resolver } = input;
  const steps: PlanStep[] = [];
  const seen = new Map<string, PlanStep>();
  const push = (s: PlanStep) => {
    const key = `${s.kind}\0${s.text}\0${s.line}`;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, s);
      steps.push(s);
      return;
    }
    // Same action reached twice (for example a prop and the control behind it): one step, both reasons.
    prior.how ??= s.how;
    for (const w of s.why) if (!prior.why.includes(w)) prior.why.push(w);
    for (const c of s.checks) if (!prior.checks.includes(c) && prior.checks.length < 5) prior.checks.push(c);
  };
  /** Components that got a step from one of their elements (others fall back to "open it and check"). */
  const covered = new Set<string | undefined>();
  /** Every component whose span holds `line` is covered, so an enclosing one gets no fallback step. */
  const coverLine = (line: number) => {
    for (const c of ui.components) if (c.line <= line && line <= c.endLine) covered.add(c.name);
  };

  for (const { element: usage, reasons } of touched.elements) {
    const area = areaName(usage.component ?? baseName(file));
    for (const el of actedOn(usage, input)) {
      const line = el.own[0]![0];
      const markupChanged = el === usage ? reasons.some((r) => r.kind === 'markup') : el.own.some(([a, b]) => hit(ranges, a, b));
      const handlers = handlersOf(el, input);
      const changedHandlers = handlers.filter((h) => hit(ranges, h.line, h.endLine) || (h.via && hit(ranges, h.via.line, h.via.line)));
      const conds = usage.conditions.length ? usage.conditions : el.conditions;
      const cond = conds.length ? conds[conds.length - 1]! : undefined;
      const phrase = cond ? conditionPhrase(cond.text, conditionContext(ui, cond.line)) : undefined;
      const showWhen = cond && phrase ? (cond.branch === 'else' ? phrase.neg : phrase.pos) : undefined;
      const showHow = cond && phrase ? (cond.branch === 'else' ? phrase.how?.neg : phrase.how?.pos) : undefined;
      const otherwise = cond && phrase ? (cond.branch === 'else' ? phrase.pos : phrase.neg) : undefined;
      const interactive = el.events.length > 0 || el.kind !== 'element';

      const why: string[] = [];
      for (const r of reasons) {
        if (r.kind === 'markup') why.push(`The ${elementName(usage)} was edited`);
        else if (r.kind === 'handler') why.push(`Its ${humanize(r.event ?? 'event')} handler (${r.name}) changed`);
        else why.push(`The condition that shows it changed (\`${r.condition.text}\`)`);
      }

      // Non-interactive element shown only under a condition: a "look at it in this state" step.
      if (!interactive && cond && showWhen) {
        const fb = new FlowBuilder();
        const c = conditionChain(fb, cond.text, cond, input, reasons.some((r) => r.kind === 'condition') || hit(ranges, cond.line, cond.endLine));
        const e = fb.add({ kind: 'element', label: elementName(el), file, line, changed: markupChanged });
        fb.link(c, e);
        const what = el.label ? quote(el.label) : `the ${humanize(el.tag)}`;
        push({
          kind: 'state',
          area,
          text: `Look at the ${area.toLowerCase()} when ${showWhen}`,
          checks: [`${sentence(what)} ${cond.branch === 'else' ? 'is shown instead' : 'is shown'}`, ...(otherwise ? [`Once ${otherwise}, it goes away`] : [])],
          how: showHow,
          why,
          file,
          line,
          flow: fb.build(),
        });
        coverLine(usage.own[0]![0]);
        coverLine(line);
        continue;
      }

      // One of the app's own components rendered on this screen: "find it and check it".
      if (!interactive && el.usage) {
        const spec = ui.imports[el.tag]?.spec;
        const target = spec ? resolver.importFile(file, spec) : undefined;
        // Only worth a step when the component itself is part of this change; rendering an untouched
        // component is not a behavior change (and in a new file, would list every child).
        const decl = target ? resolver.declSpan(target, el.tag) : undefined;
      if (!target || !(decl ? resolver.changed(target, decl.line, decl.endLine) : resolver.changed(target))) continue;
        const fb = new FlowBuilder();
        const e = fb.add({ kind: 'element', label: humanize(el.tag), file, line, changed: markupChanged });
        fb.link(e, fb.add({ kind: 'component', label: el.tag, file: target, line: 1, changed: true }));
        coverLine(usage.own[0]![0]);
        coverLine(line);
        push({
          kind: 'view',
          area,
          text: `Open the ${area.toLowerCase()} and find the ${humanize(el.tag)}`,
          checks: ['It shows up where you expect and looks right', 'Anything you can click or type into in it still works'],
          why,
          file,
          line,
          flow: fb.build(),
        });
        continue;
      }

    // Interactive: one step per changed handler on a custom component, else a single step.
      const native = isNative(el.tag);
      const chosen: Array<Handler | undefined> = !handlers.length ? [undefined] : native ? [changedHandlers[0] ?? handlers[0]] : changedHandlers.length ? changedHandlers : [handlers[0]];
      for (const h of chosen) {
        const fb = new FlowBuilder();
        const elId = fb.add({ kind: 'element', label: elementName(el), file, line, changed: markupChanged });
        if (cond && reasons.some((r) => r.kind === 'condition')) fb.link(conditionChain(fb, cond.text, cond, input, true), elId);
        const callees: Callee[] = [];
        let hasTry = false;
        if (h) {
          hasTry = h.hasTry;
          const hChanged = hit(ranges, h.line, h.endLine);
          let from = fb.add({ kind: 'handler', label: h.label, file, line: h.line, changed: hChanged });
          fb.link(elId, from);
          if (h.via) {
            const hop = fb.add({ kind: 'handler', label: `${h.via.prop} in ${areaName(h.via.parent).toLowerCase()}`, file, line: h.via.line, changed: hit(ranges, h.via.line, h.via.line) });
            fb.link(from, hop);
            from = hop;
          }
          for (const raw of h.calls) {
            const c = resolveCall(raw.name, input, raw.at);
            if (!c || callees.some((x) => x.label === c.label)) continue;
            callees.push(c);
            if ((c.kind === 'remote' || c.kind === 'local') && callees.filter((x) => x.kind === 'remote' || x.kind === 'local').length <= 3) {
              const id = fb.add({ kind: 'call', label: c.label, file: c.file, line: c.line, changed: calleeChanged(c, resolver) });
              fb.link(from, id);
            }
          }
        }
        const checks = h ? checksFor(callees, hasTry) : ['It still looks right and does what it did before'];
        if (h && !changedHandlers.includes(h) && !reasons.some((r) => r.kind === 'handler') && checks[0] === 'It still does what it did before') {
          checks[0] = 'It still looks right and does what it did before';
        }
        coverLine(usage.own[0]![0]);
        coverLine(line);
        push({
          kind: stepKindOf(el),
          area,
          text: actionText(el, h, area),
          checks,
          how: showWhen ? `This only appears when ${showWhen}.${showHow ? ` ${showHow}` : ''}` : undefined,
          why,
          file,
          line,
          flow: fb.build(),
        });
      }
    }
  }

  // Components whose code changed outside every element above.
  for (const c of touched.components) {
    if (covered.has(c.name)) continue;
    const fb = new FlowBuilder();
    fb.add({ kind: 'component', label: c.name, file, line: c.line, changed: true });
    push({
      kind: 'view',
      area: areaName(c.name),
      text: `Open the ${areaName(c.name).toLowerCase()} and check it still renders and behaves as before`,
      checks: ['Nothing looks different or broken', 'Anything you can click or type into still works'],
      why: [`Code in ${c.name} changed, outside any button, field or condition`],
      file,
      line: c.line,
      flow: fb.build(),
    });
  }

  // No UI in this file: point at the functions that changed.
  if (!steps.length) {
    for (const name of fnNames.slice(0, 6)) {
      const fb = new FlowBuilder();
      fb.add({ kind: 'call', label: name, file, line: resolver.declSpan(file, name)?.line ?? 1, changed: true });
      push({
        kind: 'logic',
        area: areaName(baseName(file)),
        text: `Try what uses \`${name}\``,
        checks: ['It still behaves as before'],
        why: [`\`${name}\` changed in ${file}`],
        file,
        line: resolver.declSpan(file, name)?.line ?? 1,
        flow: fb.build(),
      });
    }
  }
  return steps;
}
