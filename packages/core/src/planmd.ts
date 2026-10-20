import { specificScreens, type ImpactedScreen, type PlanStep, type TestPlan } from './impact.ts';

/** `/settings/tags` -> `Settings › Tags`; `/users/:id` -> `Users › (id)`; `/` -> `Home`. */
export function routeTitle(route: string): string {
  const parts = route.split('/').filter(Boolean);
  if (!parts.length) return 'Home';
  return parts
    .map((p) => (p.startsWith(':') ? `(${p.slice(1).replace(/_+$/, '')})` : p === '*' ? '(any)' : p.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())))
    .join(' › ');
}

/** Escape markdown syntax in prose; text between backticks is a code span and is kept as is. */
export function mdEscape(text: string): string {
  return text
    .split('`')
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/[\\*_[\]<>]/g, '\\$&')))
    .join('`')
    .replace(/\r?\n/g, ' ');
}

/** Markdown checklist for a PR description. */
export function planMarkdown(plan: TestPlan): string {
  const out: string[] = ['## Test plan', ''];
  if (plan.entries === 0) {
    out.push('_No screens were detected, so this plan cannot say where to look. Pass `--entry <glob>` to name them._', '');
  }
  const step = (s: PlanStep, indent: string) => {
    out.push(`${indent}- [ ] ${mdEscape(s.text)} _(${mdEscape(s.area)})_`);
    for (const c of s.checks) out.push(`${indent}  - Check: ${mdEscape(c)}`);
    if (s.how) out.push(`${indent}  - Setup: ${mdEscape(s.how)}`);
    out.push(`${indent}  - Changed: ${mdEscape(s.why.join('; '))} (\`${s.file}:${s.line}\`)`);
  };
  const stepLines = (files: string[], indent: string) => {
    const seen = new Set<string>();
    for (const f of files) {
      for (const s of plan.steps[f] ?? []) {
        const key = `${s.text}\0${f}\0${s.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        step(s, indent);
      }
    }
  };
  const screen = (s: ImpactedScreen) => {
    out.push(`### ${mdEscape(routeTitle(s.entry.route))} (\`${s.entry.route}\`)`, '');
    stepLines(s.reached.filter((r) => !r.shared).map((r) => r.file), '');
    const shared = s.reached.filter((r) => r.shared);
    if (shared.length) out.push(`- Also affected through shared code: ${shared.map((r) => `\`${r.file}\``).join(', ')}`);
    out.push('');
  };
  const screens = specificScreens(plan.impact);
  for (const s of screens) screen(s);
  if (plan.impact.shared.length) {
    out.push('### Shared code', '');
    for (const sh of plan.impact.shared) {
      out.push(`- \`${sh.file}\` is used by ${sh.screens} screens; spot-check one or two:`);
      stepLines([sh.file], '  ');
    }
    out.push('');
  }
  if (plan.impact.unreached.length) {
    out.push('### Not reached from any screen', '', ...plan.impact.unreached.map((f) => `- \`${f}\``), '');
  }
  if (plan.entries > 0 && !screens.length && !plan.impact.shared.length) out.push('_No screens are affected by this change._', '');
  return out.join('\n');
}
