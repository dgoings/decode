import { describe, expect, test } from 'bun:test';
import { bindingAt, extractUi, functionAt, parseChangedRanges, parseDiff, touchedUi, type LineRange } from '../index.ts';

const SRC = `import { useState } from 'react';

export function Page({ items, error }: Props) {
  const [name, setName] = useState('');
  const handleSave = async () => {
    await save(name);
  };
  return (
    <form onSubmit={handleSave}>
      <input name="title" placeholder="Title" onChange={(e) => setName(e.target.value)} />
      {error && <Banner kind="error">Failed to save</Banner>}
      {items.length ? <List items={items} /> : <Empty />}
      <Button variant="primary" onClick={handleSave}>Save</Button>
      <a href="/x">Go home</a>
      <p>Static text</p>
    </form>
  );
}

function helper() {
  return 1;
}
`;

describe('extractUi', () => {
  test('finds interactive and conditional elements with labels, events and conditions', async () => {
    const ui = (await extractUi(SRC, 'Page.tsx'))!;
    const by = (tag: string) => ui.elements.filter((e) => e.tag === tag);
    expect(ui.elements.map((e) => e.tag)).toEqual(['form', 'input', 'Banner', 'List', 'Empty', 'Button', 'a']);
    expect(by('form')[0]).toMatchObject({ kind: 'form', events: ['onSubmit'], handlerRefs: ['handleSave'], component: 'Page' });
    expect(by('input')[0]).toMatchObject({ kind: 'input', label: 'Title', events: ['onChange'] });
    expect(by('Button')[0]).toMatchObject({ kind: 'button', label: 'Save', events: ['onClick'], handlerRefs: ['handleSave'] });
    expect(by('a')[0]).toMatchObject({ kind: 'link', label: 'Go home' });
    expect(by('Banner')[0]!.conditions).toMatchObject([{ text: 'error', branch: 'and' }]);
    expect(by('List')[0]!.conditions).toMatchObject([{ text: 'items.length', branch: 'then' }]);
    expect(by('Empty')[0]!.conditions).toMatchObject([{ text: 'items.length', branch: 'else' }]);
    expect(ui.components.map((c) => c.name)).toEqual(['Page']);
    expect(ui.functions.map((f) => f.name).sort()).toEqual(['Page', 'handleSave', 'helper']);
  });

  test('i18n and attribute labels', async () => {
    const ui = (await extractUi(`export const X = () => <><button aria-label="Close" onClick={f} /><button>{t('save')}</button></>;`, 'x.tsx'))!;
    expect(ui.elements.map((e) => e.label)).toEqual(['Close', 'save']);
  });

  test('non JS/TS files are skipped; plain TS is parsed for its functions', async () => {
    expect(await extractUi('x', 'a.css')).toBeNull();
    const ts = (await extractUi('export const create = mutation({\n  handler: async () => {\n    return 1;\n  },\n});\n', 'a.ts'))!;
    expect(ts.elements).toEqual([]);
    expect(ts.functions.find((f) => f.name === 'create')).toMatchObject({ line: 1, endLine: 5 });
    expect(ts.functions.find((f) => f.name === 'handler')).toMatchObject({ line: 2, endLine: 4 });
  });
});

describe('touchedUi', () => {
  test('changed markup, handler body and condition each flag the right elements', async () => {
    const ui = (await extractUi(SRC, 'Page.tsx'))!;
    const line = (needle: string) => SRC.split('\n').findIndex((l) => l.includes(needle)) + 1;

    const markup = touchedUi(ui, [{ start: line('Go home'), end: line('Go home') }]);
    expect(markup.elements.map((t) => [t.element.tag, t.reasons[0]!.kind])).toEqual([['a', 'markup']]);

    const handler = touchedUi(ui, [{ start: line('await save'), end: line('await save') }]);
    expect(handler.elements.map((t) => t.element.tag)).toEqual(['form', 'Button']);
    expect(handler.elements[0]!.reasons[0]).toMatchObject({ kind: 'handler', name: 'handleSave', event: 'onSubmit' });

    // Condition and both branches share one line: reported once, as markup (no separate condition reason).
    const cond = touchedUi(ui, [{ start: line('items.length ?'), end: line('items.length ?') }]);
    expect(cond.elements.map((t) => t.element.tag).sort()).toEqual(['Empty', 'List']);
    expect(cond.elements.flatMap((t) => t.reasons.map((r) => r.kind))).toEqual(['markup', 'markup']);

    const err = touchedUi(ui, [{ start: line('{error &&'), end: line('{error &&') }]);
    expect(err.elements.map((t) => t.element.tag)).toEqual(['Banner']);
  });

  test('a condition on its own line flags the elements it guards', async () => {
    const multi = `export function P({ ok }) {
  return (
    <div>
      {ok && (
        <button onClick={go}>Go</button>
      )}
    </div>
  );
}
`;
    const ui = (await extractUi(multi, 'P.tsx'))!;
    const r = touchedUi(ui, [{ start: 4, end: 4 }]);
    expect(r.elements.map((t) => [t.element.tag, t.reasons.map((x) => x.kind)])).toEqual([['button', ['condition']]]);
  });

  test('a pure deletion only touches code that spans the removal point', async () => {
    const ui = (await extractUi(TAGS, 'T.tsx'))!;
    const at = (needle: string) => TAGS.split('\n').findIndex((l) => l.includes(needle)) + 1;
    const swatch = (r: LineRange) => touchedUi(ui, [r]).elements.some((e) => e.element.repeated);
    // The swatch's opening tag spans several lines; removing one of them lands inside it.
    expect(swatch({ start: at('aria-label') + 0.5, end: at('aria-label') + 0.5 })).toBe(true);
    // Removing lines right after its closing `/>` leaves the button untouched.
    const closing = TAGS.split('\n').findIndex((l, i) => i > at('aria-label') && l.trim() === '/>') + 1;
    expect(swatch({ start: closing + 0.5, end: closing + 0.5 })).toBe(false);
  });

  test('logic outside any element still reports the component', async () => {
    const ui = (await extractUi(SRC, 'Page.tsx'))!;
    const r = touchedUi(ui, [{ start: 4, end: 4 }]);
    expect(r.elements).toEqual([]);
    expect(r.components.map((c) => c.name)).toEqual(['Page']);
    expect(touchedUi(ui, [{ start: 20, end: 20 }])).toEqual({ elements: [], components: [] });
  });
});

describe('parseChangedRanges', () => {
  test('head-side ranges per file, deletions become a point', () => {
    const diff = [
      'diff --git a/src/a.tsx b/src/a.tsx',
      '--- a/src/a.tsx',
      '+++ b/src/a.tsx',
      '@@ -3 +3 @@ x',
      '-a',
      '+b',
      '@@ -10,2 +10,4 @@ y',
      '-c',
      '-d',
      '+e',
      '+f',
      '+g',
      '+h',
      '@@ -20,3 +22,0 @@ z',
      '-i',
      '-j',
      '-k',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-l',
      '-m',
    ].join('\n');
    const r = parseChangedRanges(diff);
    expect(r.get('src/a.tsx')).toEqual([{ start: 3, end: 3 }, { start: 10, end: 13 }, { start: 22.5, end: 22.5 }]);
    expect(r.has('gone.ts')).toBe(false);
  });

  test('an added line that looks like a file header does not switch files', () => {
    const diff = ['+++ b/real.tsx', '@@ -1,0 +2,2 @@', '+++ not a header (added line "++ not a header")', '+second', '@@ -9 +9 @@', '-old', '+new'].join('\n');
    const r = parseChangedRanges(diff);
    expect([...r.keys()]).toEqual(['real.tsx']);
    expect(r.get('real.tsx')).toEqual([{ start: 2, end: 3 }, { start: 9, end: 9 }]);
  });

  test('deleted files and renames are reported from the same diff', () => {
    const diff = [
      'diff --git a/gone.tsx b/gone.tsx',
      'deleted file mode 100644',
      '--- a/gone.tsx',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      'diff --git a/old.ts b/new dir/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to "new dir/new.ts"',
      'diff --git a/x.tsx b/x.tsx',
      '--- a/x.tsx',
      '+++ b/x.tsx',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const d = parseDiff(diff);
    expect(d.deleted).toEqual(['gone.tsx']);
    expect(d.renamed).toEqual(['new dir/new.ts']);
    expect([...d.ranges.keys()]).toEqual(['x.tsx']);
  });

  test('quoted paths and trailing tabs are cleaned before the b/ prefix', () => {
    const diff = ['+++ "b/dir/we\\"ird.tsx"', '@@ -1 +1 @@', '-x', '+y', '+++ b/with space.tsx\t', '@@ -2 +2 @@', '-x', '+y'].join('\n');
    const r = parseChangedRanges(diff);
    expect([...r.keys()]).toEqual(['dir/we"ird.tsx', 'with space.tsx']);
  });
});

// Trimmed from a real settings component: template labels, a `.map`, handlers living in a child
// component's props, a query-backed loading state and Convex-style hooks.
const TAGS = `import { useMutation, useQuery } from "convex/react";
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
  const [pending, setPending] = useState(null);
  return (
    <section>
      {tags === undefined ? (
        <p>Loading…</p>
      ) : (
        <EditableNameList addLabel="Add tag" placeholder="Pairing" onAdd={(name) => createTag({ name })} />
      )}
      <TagColorPicker value="x" onChange={(color) => updateTag({ color })} />
      <button onClick={() => setPending(null)}>Remove "{pending?.name}"?</button>
    </section>
  );
}
`;

describe('extractUi on real-world shapes', () => {
  test('template labels keep their static part and mark dynamic parts; map marks repetition', async () => {
    const ui = (await extractUi(TAGS, 'T.tsx'))!;
    const swatch = ui.elements.find((e) => e.tag === 'button' && e.repeated)!;
    expect(swatch.label).toBe('Colour …');
    expect(swatch.inline[0]).toMatchObject({ event: 'onClick', calls: ['onChange'] });
    const remove = ui.elements.find((e) => e.label?.startsWith('Remove'))!;
    expect(remove.label).toBe('Remove "…"?');
    expect(remove.repeated).toBe(false);
  });

  test('custom components keep their static props and inline handler calls', async () => {
    const ui = (await extractUi(TAGS, 'T.tsx'))!;
    const list = ui.elements.find((e) => e.tag === 'EditableNameList')!;
    expect(list.props).toEqual({ addLabel: 'Add tag', placeholder: 'Pairing' });
    expect(list.events).toEqual(['onAdd']);
    expect(list.inline[0]).toMatchObject({ event: 'onAdd', calls: ['createTag'], hasTry: false });
    expect(list.inline[0]!.line).toBeGreaterThan(0);
    expect(list.conditions).toMatchObject([{ text: 'tags === undefined', branch: 'else' }]);
    expect(list.component).toBe('TagsSettingsSection');
  });

  test('imports, hook bindings, state setters and component props', async () => {
    const ui = (await extractUi(TAGS, 'T.tsx'))!;
    expect(ui.imports.api).toEqual({ spec: '../../convex/_generated/api', name: 'api' });
    expect(ui.imports.EditableNameList).toEqual({ spec: '@/components/EditableNameList', name: 'EditableNameList' });
    expect(ui.bindings.tags![0]).toMatchObject({ call: 'useQuery', arg: 'api.taskTags.list' });
    expect(ui.bindings.createTag![0]).toMatchObject({ call: 'useMutation', arg: 'api.taskTags.create' });
    expect(ui.bindings.setPending![0]).toMatchObject({ setter: true });
    expect(ui.bindings.pending![0]!.setter).toBe(false);
    expect(ui.components.find((c) => c.name === 'TagColorPicker')!.props).toEqual(['value', 'onChange']);
  });

  test('bindingAt picks the nearest declaration above the use, so components can reuse names', async () => {
    const ui = (await extractUi(`export function A() {
  const go = useMutation(api.a.save);
  return <button onClick={() => go()}>A</button>;
}
export function B() {
  const go = useMutation(api.b.save);
  return <button onClick={() => go()}>B</button>;
}`, 'two.tsx'))!;
    expect(ui.bindings.go).toHaveLength(2);
    expect(bindingAt(ui, 'go', 3)!.arg).toBe('api.a.save');
    expect(bindingAt(ui, 'go', 7)!.arg).toBe('api.b.save');
    expect(bindingAt(ui, 'nope', 1)).toBeUndefined();
    expect(bindingAt(ui, 'go', 1)).toBeUndefined(); // declared only below this line
  });

  test('two components with a handler of the same name keep their own: edits and lookups do not cross', async () => {
    const src = `export function A() {
  const handleSave = () => { a(); };
  return <button onClick={handleSave}>A</button>;
}
export function B() {
  const handleSave = () => { b(); };
  return <button onClick={handleSave}>B</button>;
}`;
    const ui = (await extractUi(src, 'two.tsx'))!;
    expect(functionAt(ui, 'handleSave', 3)!.line).toBe(2);
    expect(functionAt(ui, 'handleSave', 7)!.line).toBe(6);
    expect(functionAt(ui, 'handleSave', 7)!.calls).toEqual(['b']);
    // Editing B's handler body flags only B's button.
    const t = touchedUi(ui, [{ start: 6, end: 6 }]);
    expect(t.elements.map((e) => e.element.label)).toEqual(['B']);
  });

  test('arrow functions stored as object properties are functions too', async () => {
    const ui = (await extractUi('export const api = {\n  save: (id: string) => id,\n  list: () => [],\n};\n', 'api.ts'))!;
    expect(ui.functions.map((f) => [f.name, f.line, f.endLine]).filter(([n]) => n !== 'api')).toEqual([['save', 2, 2], ['list', 3, 3]]);
  });

  test('backticks in labels and conditions become quotes, so they cannot break markdown code spans', async () => {
    const ui = (await extractUi("export const X = ({ a }) => <>{a && <button>Run `now`</button>}</>;", 'x.tsx'))!;
    expect(ui.elements.find((e) => e.tag === 'button')!.label).toBe("Run 'now'");
  });

  test('function bodies report their calls and try/catch', async () => {
    const ui = (await extractUi(`export function F() {
  const go = async () => {
    try { await api.save(1); toast.success('ok'); } catch (e) { setError(e); }
  };
  return <button onClick={go}>Go</button>;
}`, 'F.tsx'))!;
    const go = ui.functions.find((f) => f.name === 'go')!;
    expect(go.calls).toEqual(['api.save', 'toast.success', 'setError']);
    expect(go.hasTry).toBe(true);
  });
});
