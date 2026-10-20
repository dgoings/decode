// Pure helpers for the test plan panel (no DOM).
import type { Flow, FlowNode, ImpactedScreen, PlanStep, TestPlan } from '@codeviz/core';
// Direct file import: the core barrel pulls in node:* modules, planmd.ts is pure.
import { routeTitle } from '@codeviz/core/src/planmd.ts';
import { specificScreens } from '@codeviz/core/src/impact.ts';

/** Split step text on backticks: odd segments are code. */
export function richParts(text: string): Array<{ code: boolean; text: string }> {
  return text
    .split('`')
    .map((t, i) => ({ code: i % 2 === 1, text: t }))
    .filter((p) => p.text !== '');
}

/** Identity of a checklist item, stable across reloads of the same comparison. */
export const stepKey = (base: string, head: string, step: PlanStep): string =>
  `${base}\n${head}\n${step.file}\n${step.line}\n${step.text}`;

/** Ticks for a `WORKTREE` head are not kept: the files under them keep changing. */
export const isWorktreeKey = (key: string): boolean => key.split('\n')[1] === 'WORKTREE';

/** The steps listed under a screen: those of its non-shared changed files, nearest first, each once. */
export function screenSteps(plan: TestPlan, screen: ImpactedScreen): Array<{ file: string; steps: PlanStep[] }> {
  const out: Array<{ file: string; steps: PlanStep[] }> = [];
  for (const r of screen.reached) {
    if (r.shared) continue;
    const steps = plan.steps[r.file];
    if (steps?.length) out.push({ file: r.file, steps });
  }
  return out;
}

/** Every step the plan lists (screen steps plus shared-file steps), once per file/text. */
export function allSteps(plan: TestPlan): PlanStep[] {
  const seen = new Set<string>();
  const out: PlanStep[] = [];
  const add = (steps: PlanStep[] | undefined) => {
    for (const s of steps ?? []) {
      const k = `${s.file}\n${s.line}\n${s.text}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(s);
      }
    }
  };
  for (const screen of specificScreens(plan.impact)) for (const g of screenSteps(plan, screen)) add(g.steps);
  for (const sh of plan.impact.shared) add(plan.steps[sh.file]);
  return out;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const baseName = (file: string): string => file.replace(/^.*\//, '');

/**
 * A step's flow with the path from the screen to its file in front: screen -> (components in
 * between) -> the step's own graph. `chain` is the import chain from the screen file to the changed
 * file (`Reach.chain`); without one (shared code) the flow is returned as is.
 */
export function flowWithPath(step: PlanStep, chain: string[] | undefined, route: string): Flow {
  if (!chain || chain.length === 0) return step.flow;
  const ids = new Set(step.flow.nodes.map((n) => n.id));
  const pid = (i: number): string => {
    let id = `p${i}`;
    while (ids.has(id)) id = `_${id}`;
    return id;
  };
  const nodes: FlowNode[] = [{ id: pid(0), kind: 'screen', label: routeTitle(route), file: chain[0], line: 1 }];
  const middle = chain.slice(1, -1);
  if (middle.length === 1) nodes.push({ id: pid(1), kind: 'component', label: baseName(middle[0]!).replace(/\.[^.]+$/, ''), file: middle[0], line: 1 });
  else if (middle.length > 1) nodes.push({ id: pid(1), kind: 'component', label: `${middle.length} components`, file: middle[0], line: 1 });
  const edges: Array<[string, string]> = [];
  for (let i = 1; i < nodes.length; i++) edges.push([nodes[i - 1]!.id, nodes[i]!.id]);
  const hasIncoming = new Set(step.flow.edges.map(([, to]) => to));
  const roots = step.flow.nodes.filter((n) => !hasIncoming.has(n.id));
  const last = nodes[nodes.length - 1]!.id;
  for (const r of roots) edges.push([last, r.id]);
  return { nodes: [...nodes, ...step.flow.nodes], edges: [...edges, ...step.flow.edges] };
}
