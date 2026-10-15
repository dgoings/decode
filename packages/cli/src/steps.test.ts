import { describe, expect, test } from 'bun:test';
import { extractUi, touchedUi, type LineRange } from '@codeviz/analyzers';
import { buildSteps, type Resolver } from './steps.ts';

// Trimmed from a real settings component. Line numbers matter for the "changed" checks below.
const SRC = `import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { EditableNameList } from "@/components/EditableNameList";

function TagColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div>
      {COLORS.map((color) => (
        <button
          key={color}
          aria-label={\`Colour \${LABEL[color]}\`}
          onClick={() => void onChange(color)}
        />
      ))}
    </div>
  );
}

export function TagsSettingsSection() {
  const tags = useQuery(api.taskTags.list);
  const createTag = useMutation(api.taskTags.create);
  const updateTag = useMutation(api.taskTags.update);
  const [pending, setPending] = useState(null);
  return (
    <section>
      {tags === undefined ? (
        <p>Loading…</p>
      ) : (
        <EditableNameList addLabel="Add tag" placeholder="Pairing" onAdd={(name) => createTag({ name })} />
      )}
      <TagColorPicker value="x" onChange={(color) => updateTag({ color })} />
      <button onClick={() => setPending(null)}>Remove</button>
    </section>
  );
}
`;
const FILE = 'src/components/TagsSettingsSection.tsx';
const lineOf = (needle: string): number => SRC.split('\n').findIndex((l) => l.includes(needle)) + 1;

function resolver(changedFiles: Record<string, LineRange[]> = {}): Resolver {
  return {
    importFile: () => undefined,
    apiModuleFile: (_f, _s, seg) => `convex/${seg.join('/')}.ts`,
    declSpan: (file, name) => (file.startsWith('convex/') ? { line: 40, endLine: 55 } : name ? { line: 1, endLine: 2 } : undefined),
    changed: (file, from, to) => (changedFiles[file] ?? []).some((r) => from === undefined || (r.start <= (to ?? from) && from <= r.end)),
  };
}

async function plan(ranges: LineRange[], changedFiles?: Record<string, LineRange[]>) {
  const ui = (await extractUi(SRC, FILE))!;
  return buildSteps({ file: FILE, ui, touched: touchedUi(ui, ranges), ranges, fnNames: [], resolver: resolver(changedFiles) });
}
const at = (needle: string): LineRange[] => [{ start: lineOf(needle), end: lineOf(needle) }];

describe('buildSteps on a real-world component', () => {
  test('an unlabeled-looking swatch button becomes a clear click, with the backend call it ends in', async () => {
    const [s] = await plan(at('aria-label'));
    expect(s!.text).toBe('Click any of the “Colour …” buttons');
    expect(s!.area).toBe('Tag color picker');
    expect(s!.checks).toEqual(['The change is saved']);
    expect(s!.kind).toBe('click');
    // swatch button -> its onClick -> the onChange prop the section passes -> taskTags.update
    expect(s!.flow.nodes.map((n) => [n.kind, n.label])).toEqual([
      ['element', '“Colour …” button'],
      ['handler', 'onClick'],
      ['handler', 'onChange in tags settings section'],
      ['call', 'taskTags.update'],
    ]);
    expect(s!.flow.nodes[3]).toMatchObject({ file: 'convex/taskTags.ts', line: 40 });
    expect(s!.flow.edges).toEqual([['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3']]);
  });

  test('a change to the passed prop handler describes the control inside the component, not "change an item"', async () => {
    const steps = await plan(at('onChange={(color) => updateTag'));
    expect(steps.map((s) => s.text)).toEqual(['Click any of the “Colour …” buttons']);
    expect(steps[0]!.flow.nodes.find((n) => n.label.startsWith('onChange in'))!.changed).toBe(true);
    expect(steps[0]!.flow.nodes[0]!.changed).toBe(false); // the swatch markup itself did not change
  });

  test('"tags === undefined" reads as a loading state, with how to get there and where the data comes from', async () => {
    const steps = await plan(at('<p>Loading'));
    const s = steps.find((x) => x.kind === 'state')!;
    expect(s.text).toBe('Look at the tags settings section when the tags are still loading');
    expect(s.checks).toEqual(['“Loading…” is shown', 'Once the tags have loaded, it goes away']);
    expect(s.how).toContain('slow the network');
    expect(s.flow.nodes.map((n) => [n.kind, n.label])).toEqual([
      ['call', 'taskTags.list'],
      ['state', 'tags (useQuery)'],
      ['condition', 'tags === undefined'],
      ['element', '“Loading…” text'],
    ]);
    expect(s.flow.edges).toEqual([['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3']]);
  });

  test('a custom component with an "addLabel" prop is the "Add tag" button, ending in the create call', async () => {
    const steps = await plan(at('onAdd='));
    const s = steps.find((x) => x.text === 'Click “Add tag”')!;
    expect(s.checks).toEqual(['The new item is created']);
    expect(s.how).toBe('This only appears when the tags have loaded.');
    expect(s.flow.nodes.map((n) => n.label)).toContain('taskTags.create');
    expect(s.flow.nodes.find((n) => n.label === 'onAdd')!.changed).toBe(true);
  });

  test('a callee in another file is marked changed only when the diff touches its lines', async () => {
    const hit = await plan(at('aria-label'), { 'convex/taskTags.ts': [{ start: 45, end: 46 }] });
    expect(hit[0]!.flow.nodes.find((n) => n.label === 'taskTags.update')!.changed).toBe(true);
    const miss = await plan(at('aria-label'), { 'convex/taskTags.ts': [{ start: 1, end: 2 }] });
    expect(miss[0]!.flow.nodes.find((n) => n.label === 'taskTags.update')!.changed).toBe(false);
  });

  test('merging the same action keeps the setup hint from whichever step had one', async () => {
    const steps = await plan([{ start: 1, end: 1000 }]);
    const add = steps.find((s) => s.text === 'Click “Add tag”')!;
    expect(add.how).toBe('This only appears when the tags have loaded.');
  });

  test('same label in different areas stays two steps, each with its own flow', async () => {
    const src = `import { api } from "../convex/_generated/api";
export function A() {
  const go = useMutation(api.a.save);
  return <button onClick={() => go()}>Save</button>;
}
export function B() {
  const go = useMutation(api.b.save);
  return <button onClick={() => go()}>Save</button>;
}`;
    const ui = (await extractUi(src, 'two.tsx'))!;
    const ranges = [{ start: 1, end: 100 }];
    const steps = buildSteps({ file: 'two.tsx', ui, touched: touchedUi(ui, ranges), ranges, fnNames: [], resolver: resolver() });
    expect(steps.map((s) => [s.area, s.text])).toEqual([['A', 'Click “Save”'], ['B', 'Click “Save”']]);
    expect(steps.map((s) => s.flow.nodes.find((n) => n.kind === 'call')!.label)).toEqual(['a.save', 'b.save']);
  });

  test('state setters read as the screen updating; same action reached twice is one step', async () => {
    const steps = await plan([{ start: 1, end: 1000 }]);
    expect(steps.find((s) => s.text === 'Click “Remove”')!.checks).toEqual(['The screen updates to match']);
    const texts = steps.map((s) => s.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.filter((t) => t.startsWith('Click any of'))).toHaveLength(1);
  });

  test('no step text exposes raw condition syntax or tag names', async () => {
    const steps = await plan([{ start: 1, end: 1000 }]);
    for (const s of steps) {
      expect(s.text).not.toMatch(/===|<\w+>|undefined/);
      for (const c of s.checks) expect(c).not.toMatch(/===|undefined/);
    }
  });

  test('a component with only logic changes is a plain "open it and check" step', async () => {
    const steps = await plan(at('const [pending'));
    expect(steps.map((s) => s.kind)).toEqual(['view']);
    expect(steps[0]!.text).toBe('Open the tags settings section and check it still renders and behaves as before');
  });
});

test('files with no UI point at the changed functions', async () => {
  const ui = (await extractUi('export function save() {\n  return 1;\n}\n', 'lib/api.ts'))!;
  const steps = buildSteps({ file: 'lib/api.ts', ui, touched: touchedUi(ui, [{ start: 2, end: 2 }]), ranges: [{ start: 2, end: 2 }], fnNames: ['save'], resolver: resolver() });
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ kind: 'logic', text: 'Try what uses `save`', area: 'Api' });
});

describe('realistic shapes from a settings screen', () => {
  const SETTINGS = `import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TagsSettingsSection } from "@/components/TagsSettingsSection";

export function AdminSettings() {
  const tags = useQuery(api.taskTags.list);
  const removeTag = useMutation(api.taskTags.remove);
  return (
    <main>
      <TagsSettingsSection />
      <RemoveDialog onCancel={() => setPending(null)} onConfirm={async (id) => { await removeTag({ tagId: id }); }} />
    </main>
  );
}

function RemoveDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (id: string) => void }) {
  return (
    <Dialog open={true} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogTitle>Remove tag?</DialogTitle>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onConfirm("x")}>Remove</Button>
      </DialogContent>
    </Dialog>
  );
}
`;
  const F = 'src/routes/admin/settings.tsx';
  const run = async (needle: string) => {
    const ui = (await extractUi(SETTINGS, F))!;
    const l = SETTINGS.split('\n').findIndex((x) => x.includes(needle)) + 1;
    const ranges = [{ start: l, end: l }];
    return buildSteps({ file: F, ui, touched: touchedUi(ui, ranges), ranges, fnNames: [], resolver: {
      importFile: (_f, spec) => (spec.endsWith('TagsSettingsSection') ? 'src/components/TagsSettingsSection.tsx' : undefined),
      apiModuleFile: (_f, _s, seg) => `convex/${seg.join('/')}.ts`,
      declSpan: () => ({ line: 5, endLine: 9 }),
      changed: (file, from) => file === 'src/components/TagsSettingsSection.tsx' && (from === undefined || from <= 9),
    } });
  };

  test('adding an app component to a screen says to find it there, and links to its file', async () => {
    const steps = await run('<TagsSettingsSection />');
    expect(steps.map((s) => s.text)).toEqual(['Open the admin settings and find the tags settings section']);
    expect(steps[0]!.flow.nodes.map((n) => [n.kind, n.label, n.file])).toEqual([
      ['element', 'tags settings section', F],
      ['component', 'TagsSettingsSection', 'src/components/TagsSettingsSection.tsx'],
    ]);
    expect(steps[0]!.flow.nodes[1]!.changed).toBe(true);
  });

  test('a component exported from a changed file is still untouched when its own lines did not change', async () => {
    const ui = (await extractUi(SETTINGS, F))!;
    const l = SETTINGS.split('\n').findIndex((x) => x.includes('<TagsSettingsSection />')) + 1;
    const steps = buildSteps({ file: F, ui, touched: touchedUi(ui, [{ start: l, end: l }]), ranges: [{ start: l, end: l }], fnNames: [], resolver: {
      importFile: () => 'src/components/AppShell.tsx',
      apiModuleFile: () => undefined,
      declSpan: () => ({ line: 100, endLine: 120 }),
      changed: (_f, from) => from === undefined || (from <= 30 && 30 <= 40), // only lines 30-40 of the file changed
    } });
    expect(steps.map((s) => s.kind)).toEqual(['view']);
    expect(steps[0]!.text).toContain('check it still renders');
  });

  test('rendering an untouched component is not a step; the screen falls back to "open it and check"', async () => {
    const ui = (await extractUi(SETTINGS, F))!;
    const l = SETTINGS.split('\n').findIndex((x) => x.includes('<TagsSettingsSection />')) + 1;
    const ranges = [{ start: l, end: l }];
    const steps = buildSteps({ file: F, ui, touched: touchedUi(ui, ranges), ranges, fnNames: [], resolver: {
      importFile: () => 'src/components/TagsSettingsSection.tsx',
      apiModuleFile: () => undefined,
      declSpan: () => undefined,
      changed: () => false, // the component's own file is not part of the change
    } });
    expect(steps.map((s) => [s.kind, s.text])).toEqual([['view', 'Open the admin settings and check it still renders and behaves as before']]);
  });

  test('UI-kit buttons and dialogs read as clicks and dialogs, following props to the real call', async () => {
    const steps = await run('<Button onClick={() => onConfirm');
    expect(steps.map((s) => s.text)).toEqual(['Click “Remove”']);
    expect(steps[0]!.checks).toContain('The item is removed');
    const dialog = await run('<Dialog open');
    expect(dialog.some((s) => s.text.startsWith('Open the “Remove tag?” dialog'))).toBe(true);
  });

  test('reading a query result inside a handler is not reported as a backend effect', async () => {
    const src = `import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
export function T() {
  const tags = useQuery(api.taskTags.list);
  return <button onClick={() => tags.find((t) => t.id === 1)}>Find</button>;
}`;
    const ui = (await extractUi(src, 'T.tsx'))!;
    const ranges = [{ start: 5, end: 5 }];
    const [s] = buildSteps({ file: 'T.tsx', ui, touched: touchedUi(ui, ranges), ranges, fnNames: [], resolver: resolver() });
    expect(s!.checks).toEqual(['It still does what it did before']);
    expect(s!.flow.nodes.map((n) => n.kind)).not.toContain('call');
  });
});

test('toast and router from hooks still read as a notification and a page change', async () => {
  const src = `export function T() {
  const router = useRouter();
  const { toast } = useToast();
  return <button onClick={() => { toast.success('x'); router.push('/a'); }}>Go</button>;
}`;
  const ui = (await extractUi(src, 'T.tsx'))!;
  const ranges = [{ start: 4, end: 4 }];
  const [s] = buildSteps({ file: 'T.tsx', ui, touched: touchedUi(ui, ranges), ranges, fnNames: [], resolver: resolver() });
  expect(s!.checks).toEqual(['A notification appears', 'You are taken to the right page']);
});

test('a plain variable named message is not a notification; an enclosing component is covered too', async () => {
  const src = `export function Page() {
  function Inner() {
    const message = form.message;
    return <button onClick={() => message.trim()}>Go</button>;
  }
  return <Inner />;
}`;
  const ui = (await extractUi(src, 'P.tsx'))!;
  const ranges = [{ start: 4, end: 4 }];
  const steps = buildSteps({ file: 'P.tsx', ui, touched: touchedUi(ui, ranges), ranges, fnNames: [], resolver: resolver() });
  expect(steps.map((s) => s.kind)).toEqual(['click']);
  expect(steps[0]!.checks).toEqual(['It still does what it did before']);
});

test('only mutation-style hooks are followed to a remote function; useRef(foo) and a later same-named hook are not', async () => {
  const src = `import { api } from "../convex/_generated/api";
export function A() {
  const ref = useRef(api.a.save);
  return <button onClick={() => ref.current()}>A</button>;
}
export function B() {
  const ref = useMutation(api.b.save);
  return <button onClick={() => ref()}>B</button>;
}`;
  const ui = (await extractUi(src, 'two.tsx'))!;
  const ranges = [{ start: 1, end: 100 }];
  const steps = buildSteps({ file: 'two.tsx', ui, touched: touchedUi(ui, ranges), ranges, fnNames: [], resolver: resolver() });
  const calls = (area: string) => steps.find((s) => s.area === area)!.flow.nodes.filter((n) => n.kind === 'call').map((n) => n.label);
  expect(calls('A')).toEqual([]); // a ref is not a remote call, and B's `ref` below is not A's
  expect(calls('B')).toEqual(['b.save']);
});
