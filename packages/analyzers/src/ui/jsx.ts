import Parser from 'web-tree-sitter';
import { loadLanguage } from '../walker/walker.ts';
import { jsConfig, tsConfig, tsxConfig } from '../walker/languages/ts.ts';

export type UiKind = 'button' | 'link' | 'input' | 'form' | 'overlay' | 'element';

/** A render condition the element sits under: `cond && <X/>` or one branch of `cond ? <A/> : <B/>`. */
export interface UiCondition {
  /** Source text of the condition, whitespace collapsed and truncated. */
  text: string;
  /** `and`: shown while text is truthy; `then` / `else`: the two ternary branches. */
  branch: 'and' | 'then' | 'else';
  line: number;
  endLine: number;
}

/** A function written inline in an event prop: `onClick={() => save(id)}`. */
export interface UiInlineHandler {
  event: string;
  /** Callee texts (`api.save`, `createTag`, `toast.success`), in source order, deduplicated. */
  calls: string[];
  hasTry: boolean;
  line: number;
  endLine: number;
}

export interface UiElement {
  tag: string;
  kind: UiKind;
  /** Visible text or the best attribute stand-in (aria-label, title, placeholder, name, href). `…` marks a dynamic part. */
  label?: string;
  /** Lines the element itself owns: opening and closing tags and its direct text, not child elements. */
  own: Array<[number, number]>;
  /** Event props, e.g. `onClick`. */
  events: string[];
  /** Named handlers passed to event props (`onClick={handleSave}` -> `handleSave`). */
  handlerRefs: string[];
  /** The same, paired with the event prop each one is passed to. */
  refs: Array<{ event: string; name: string }>;
  /** Handlers written inline in event props. */
  inline: UiInlineHandler[];
  /** Static string props (`addLabel="Add tag"`), minus styling and identity props. */
  props: Record<string, string>;
  /** Rendered once per item of a list (inside `items.map(...)`). */
  repeated: boolean;
  /** Recorded only because the screen renders one of the app's own components here (no events, no kind). */
  usage?: boolean;
  /** Outermost first. */
  conditions: UiCondition[];
  /** Nearest enclosing component (capitalized function), when there is one. */
  component?: string;
}

export interface UiSpan {
  name: string;
  line: number;
  endLine: number;
}

export interface UiFunction extends UiSpan {
  /** Callee texts used anywhere in the body. */
  calls: string[];
  hasTry: boolean;
}

export interface UiComponent extends UiSpan {
  /** Destructured prop names of the first parameter. */
  props: string[];
}

/** `import { api as a } from 'x'` -> `a: { spec: 'x', name: 'api' }`; default is `default`, namespace is `*`. */
export interface UiImport {
  spec: string;
  name: string;
}

/** `const x = useQuery(api.a.b)` -> `{ call: 'useQuery', arg: 'api.a.b' }`. */
export interface UiBinding {
  call: string;
  /** First argument when it is a plain identifier or member path. */
  arg?: string;
  line: number;
  /** The setter of a `useState` / `useReducer` pair. */
  setter?: boolean;
}

export interface UiFile {
  /** Interactive elements, plus elements that appear only under a render condition. */
  elements: UiElement[];
  /** Capitalized functions that render JSX. */
  components: UiComponent[];
  /** Named functions and function-valued consts, for matching handler references. */
  functions: UiFunction[];
  imports: Record<string, UiImport>;
  /** Every declaration of a name in the file (components often reuse names); pick one with `bindingAt`. */
  bindings: Record<string, UiBinding[]>;
}

/** The declaration of `name` in force at `line`: the nearest one above it (none if the name is only declared below). */
export function bindingAt(ui: UiFile, name: string, line: number): UiBinding | undefined {
  const list = ui.bindings[name];
  if (!list) return undefined;
  let best: UiBinding | undefined;
  for (const b of list) if (b.line <= line && (!best || b.line > best.line)) best = b;
  return best;
}

const parsers = new Map<string, Promise<Parser>>();
const ready = new Map<string, Parser>();
function parserFor(wasm: string, config: typeof tsxConfig): Promise<Parser> {
  let p = parsers.get(wasm);
  if (!p) {
    p = loadLanguage(config).then((lang) => {
      const parser = new Parser();
      parser.setLanguage(lang);
      ready.set(wasm, parser);
      return parser;
    });
    parsers.set(wasm, p);
  }
  return p;
}

const NATIVE: Record<string, UiKind> = {
  button: 'button',
  a: 'link',
  input: 'input',
  textarea: 'input',
  select: 'input',
  form: 'form',
  dialog: 'overlay',
};

function kindOf(tag: string): UiKind {
  const native = NATIVE[tag];
  if (native) return native;
  if (/(button|btn)$/i.test(tag)) return 'button';
  if (/link$/i.test(tag)) return 'link';
  if (/(input|field|select|checkbox|radio|switch|toggle|textarea|dropdown)$/i.test(tag)) return 'input';
  if (/(modal|dialog|drawer|menu|popover|sheet)$/i.test(tag)) return 'overlay';
  return 'element';
}

const clip = (s: string, max = 80): string => {
  // Backticks become quotes: these strings are shown inside markdown code spans and between quotes.
  const t = s.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const lines = (n: Parser.SyntaxNode): [number, number] => [n.startPosition.row + 1, n.endPosition.row + 1];
const isFn = (type: string) => type === 'arrow_function' || type === 'function_expression' || type === 'function';
const MEMBER_PATH = /^[\w$]+(?:\.[\w$]+)*$/;
/** Props that style or identify an element but say nothing about what it does. */
const SKIP_PROPS = new Set(['className', 'class', 'key', 'id', 'type', 'style', 'ref', 'role', 'data-testid']);

/** Text of a string literal or template (`${...}` parts become `…`), else null. Looks through `{...}` and `t('key')`. */
function stringValue(n: Parser.SyntaxNode | null): string | null {
  if (!n) return null;
  if (n.type === 'string') return n.text.slice(1, -1);
  if (n.type === 'template_string') {
    const text = n.text.slice(1, -1).replace(/\$\{[^}]*\}/g, '…');
    return /[^…\s]/.test(text) ? text : null;
  }
  if (n.type === 'jsx_expression') return stringValue(n.namedChild(0));
  if (n.type === 'call_expression') {
    // i18n helpers: t('save'), i18n.t('save')
    const fn = n.childForFieldName('function');
    const first = n.childForFieldName('arguments')?.namedChild(0) ?? null;
    if (fn && /^(?:\w+\.)?t$/.test(fn.text)) return stringValue(first);
  }
  return null;
}

interface Tag {
  open: Parser.SyntaxNode;
  name: string;
  attrs: Parser.SyntaxNode[];
}

function tagOf(node: Parser.SyntaxNode): Tag | null {
  const open = node.type === 'jsx_element' ? node.childForFieldName('open_tag') : node;
  if (!open) return null;
  const name = open.childForFieldName('name')?.text ?? ''; // '' for fragments
  const attrs: Parser.SyntaxNode[] = [];
  for (let i = 0; i < open.namedChildCount; i++) {
    const c = open.namedChild(i)!;
    if (c.type === 'jsx_attribute') attrs.push(c);
  }
  return { open, name, attrs };
}

function attr(attrs: Parser.SyntaxNode[], name: string): Parser.SyntaxNode | null {
  for (const a of attrs) if (a.namedChild(0)?.text === name) return a.namedChild(1) ?? null;
  return null;
}

/** Visible text of an element, in order: text, string expressions, and `…` for anything dynamic. */
function childText(node: Parser.SyntaxNode): string | undefined {
  if (node.type !== 'jsx_element') return undefined;
  let out = '';
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === 'jsx_text') out += c.text.replace(/\s+/g, ' ');
    else if (c.type === 'jsx_expression') {
      if (c.namedChildCount === 0) continue; // `{/* comment */}`
      out += stringValue(c) ?? '…';
    }
  }
  const t = out.replace(/\s+/g, ' ').trim();
  return /[^…\s]/.test(t) ? clip(t) : undefined;
}

function labelOf(node: Parser.SyntaxNode, tag: Tag, kind: UiKind): string | undefined {
  const text = childText(node);
  if (text) return text;
  if (kind === 'overlay') {
    // A dialog is named by its title: <DialogTitle>Remove tag?</DialogTitle>
    for (const d of node.descendantsOfType('jsx_element')) {
      if (/Title$/.test(d.childForFieldName('open_tag')?.childForFieldName('name')?.text ?? '')) {
        const t = childText(d);
        if (t) return t;
      }
    }
  }
  // `placeholder`, `name`, `value` on a custom component are data for it, not what the user sees.
  const native = /^[a-z]/.test(tag.name);
  const names = ['aria-label', 'title', 'label'];
  if (native) names.push('placeholder', 'alt', 'name', 'value', 'to', 'href');
  else if (kind === 'link') names.push('to', 'href');
  else if (kind === 'input') names.push('placeholder', 'name');
  for (const name of names) {
    const s = stringValue(attr(tag.attrs, name));
    if (s) return clip(s);
  }
  return undefined;
}

/** Callee texts of every call under `node`: plain identifiers and member paths (`a.b.c`), optional chaining normalised. */
function collectCalls(node: Parser.SyntaxNode): string[] {
  const out = new Set<string>();
  for (const c of node.descendantsOfType('call_expression')) {
    const fn = c.childForFieldName('function');
    if (!fn || (fn.type !== 'identifier' && fn.type !== 'member_expression')) continue;
    const t = fn.text.replace(/\?\./g, '.');
    if (MEMBER_PATH.test(t)) out.add(t);
  }
  return [...out].slice(0, 24);
}

const hasTry = (n: Parser.SyntaxNode): boolean => n.descendantsOfType('try_statement').length > 0 || n.text.includes('.catch(');

/** Event props on the tag, the named functions passed to them, and the ones written inline. */
function eventsOf(tag: Tag): { events: string[]; handlerRefs: string[]; refs: Array<{ event: string; name: string }>; inline: UiInlineHandler[] } {
  const events: string[] = [];
  const handlerRefs: string[] = [];
  const refs: Array<{ event: string; name: string }> = [];
  const inline: UiInlineHandler[] = [];
  for (const a of tag.attrs) {
    const name = a.namedChild(0)?.text ?? '';
    if (!/^on[A-Z]/.test(name)) continue;
    events.push(name);
    const value = a.namedChild(1);
    const expr = value?.type === 'jsx_expression' ? value.namedChild(0) : null;
    if (expr?.type === 'identifier' || expr?.type === 'member_expression') {
      const ref = expr.type === 'identifier' ? expr.text : (expr.childForFieldName('property')?.text ?? expr.text);
      handlerRefs.push(ref);
      refs.push({ event: name, name: ref });
    } else if (expr && isFn(expr.type)) {
      const [line, endLine] = lines(expr);
      inline.push({ event: name, calls: collectCalls(expr), hasTry: hasTry(expr), line, endLine });
    }
  }
  return { events, handlerRefs, refs, inline };
}

function staticProps(tag: Tag): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of tag.attrs) {
    const name = a.namedChild(0)?.text ?? '';
    if (!name || /^on[A-Z]/.test(name) || SKIP_PROPS.has(name) || out[name] !== undefined) continue;
    const v = a.namedChild(1);
    if (v?.type === 'string' || (v?.type === 'jsx_expression' && v.namedChild(0)?.type === 'string')) {
      const s = stringValue(v);
      if (s) out[name] = clip(s, 60);
    }
  }
  return out;
}

const unwrap = (n: Parser.SyntaxNode | null): Parser.SyntaxNode | null => {
  while (n?.type === 'parenthesized_expression') n = n.namedChild(0);
  return n;
};
const isJsx = (n: Parser.SyntaxNode | null): boolean => {
  const u = unwrap(n);
  return !!u && (u.type === 'jsx_element' || u.type === 'jsx_self_closing_element' || u.type === 'jsx_fragment');
};

/** Destructured prop names of a function's first parameter. */
function propNames(fn: Parser.SyntaxNode): string[] {
  const params = fn.childForFieldName('parameters');
  const first = params?.namedChild(0);
  const pattern = first?.type === 'required_parameter' || first?.type === 'optional_parameter' ? first.childForFieldName('pattern') : first;
  if (pattern?.type !== 'object_pattern') return [];
  const names: string[] = [];
  for (let i = 0; i < pattern.namedChildCount; i++) {
    const c = pattern.namedChild(i)!;
    if (c.type === 'shorthand_property_identifier_pattern') names.push(c.text);
    else if (c.type === 'pair_pattern') {
      const v = c.childForFieldName('value');
      if (v?.type === 'identifier') names.push(v.text);
    } else if (c.type === 'object_assignment_pattern') {
      const l = c.childForFieldName('left');
      if (l) names.push(l.text);
    }
  }
  return names;
}

function collectImports(root: Parser.SyntaxNode): Record<string, UiImport> {
  const out: Record<string, UiImport> = {};
  for (const stmt of root.descendantsOfType('import_statement')) {
    const spec = stringValue(stmt.childForFieldName('source'));
    if (!spec) continue;
    for (let i = 0; i < stmt.namedChildCount; i++) {
      const clause = stmt.namedChild(i)!;
      if (clause.type !== 'import_clause') continue;
      for (let j = 0; j < clause.namedChildCount; j++) {
        const c = clause.namedChild(j)!;
        if (c.type === 'identifier') out[c.text] = { spec, name: 'default' };
        else if (c.type === 'namespace_import') out[c.namedChild(0)?.text ?? ''] = { spec, name: '*' };
        else if (c.type === 'named_imports') {
          for (const s of c.descendantsOfType('import_specifier')) {
            const name = s.childForFieldName('name')?.text;
            const local = s.childForFieldName('alias')?.text ?? name;
            if (name && local) out[local] = { spec, name };
          }
        }
      }
    }
  }
  return out;
}

function configFor(path: string): typeof tsxConfig | null {
  const ext = /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? '';
  if (ext === '.tsx' || ext === '.jsx') return tsxConfig;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return tsConfig;
  return ext === '.js' || ext === '.mjs' || ext === '.cjs' ? jsConfig : null;
}

/** Load the TS, TSX and JS grammars so `extractUiSync` can be used. */
export async function loadUiParsers(): Promise<void> {
  await Promise.all([tsConfig, tsxConfig, jsConfig].map((c) => parserFor(c.wasm, c)));
}

/** `extractUi` without awaiting: needs `loadUiParsers()` (or an earlier `extractUi` of that language) first. */
export function extractUiSync(src: string, path: string): UiFile | null {
  const config = configFor(path);
  if (!config) return null;
  const parser = ready.get(config.wasm);
  if (!parser) throw new Error('extractUiSync: grammar not loaded; await loadUiParsers() first');
  const tree = parser.parse(src);
  try {
    return buildUi(tree);
  } finally {
    tree.delete();
  }
}

/** Rendering details and function spans of one source file; null for languages other than JS/TS(X). */
export async function extractUi(src: string, path: string): Promise<UiFile | null> {
  const config = configFor(path);
  if (!config) return null;
  await parserFor(config.wasm, config);
  return extractUiSync(src, path);
}

/** The function called `name` in scope at `line`: inside the component spanning it, else a module-level one. */
export function functionAt(ui: UiFile, name: string, line: number): UiFunction | undefined {
  const cands = ui.functions.filter((f) => f.name === name);
  if (cands.length <= 1) return cands[0];
  const inside = (f: UiFunction, c: UiSpan): boolean => f.line >= c.line && f.endLine <= c.endLine && f.name !== c.name;
  const comp = ui.components.filter((c) => c.line <= line && line <= c.endLine).sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
  const own = comp && cands.find((f) => inside(f, comp));
  return own ?? cands.find((f) => !ui.components.some((c) => inside(f, c))) ?? cands[0];
}

function buildUi(tree: Parser.Tree): UiFile {
  const out: UiFile = { elements: [], components: [], functions: [], imports: collectImports(tree.rootNode), bindings: {} };

  interface Ctx {
    conditions: UiCondition[];
    component?: string;
    /** The next JSX element starts a conditional branch (recorded even when not interactive). */
    branchRoot: boolean;
    /** Inside an `items.map(...)` callback: elements repeat per item. */
    repeated: boolean;
  }

  const containsJsx = (n: Parser.SyntaxNode): boolean =>
    n.descendantsOfType(['jsx_element', 'jsx_self_closing_element', 'jsx_fragment']).length > 0;

  /** `const x = useQuery(api.a.b)`, `const [v, setV] = useState()`, `const { data } = useQuery(...)`. */
  function recordBinding(node: Parser.SyntaxNode): void {
    const value = node.childForFieldName('value');
    const target = node.childForFieldName('name');
    if (!target || value?.type !== 'call_expression') return;
    const fn = value.childForFieldName('function');
    if (!fn || !MEMBER_PATH.test(fn.text.replace(/\?\./g, '.'))) return;
    const first = value.childForFieldName('arguments')?.namedChild(0);
    const arg = first && (first.type === 'identifier' || first.type === 'member_expression') && MEMBER_PATH.test(first.text) ? first.text : undefined;
    const line = node.startPosition.row + 1;
    const base: UiBinding = { call: fn.text, arg, line };
    const add = (name: string, b: UiBinding) => (out.bindings[name] ??= []).push(b);
    if (target.type === 'identifier') add(target.text, base);
    else if (target.type === 'array_pattern') {
      const pair = /^use(State|Reducer)$/.test(fn.text);
      target.namedChildren.forEach((c, i) => {
        if (c.type === 'identifier') add(c.text, { ...base, setter: pair && i === 1 });
      });
    } else if (target.type === 'object_pattern') {
      for (const c of target.namedChildren) {
        if (c.type === 'shorthand_property_identifier_pattern') add(c.text, base);
        else if (c.type === 'pair_pattern' && c.childForFieldName('value')?.type === 'identifier') add(c.childForFieldName('value')!.text, base);
      }
    }
  }

  function visit(node: Parser.SyntaxNode, ctx: Ctx): void {
    switch (node.type) {
      case 'function_declaration':
      case 'method_definition':
      case 'variable_declarator': {
        if (node.type === 'variable_declarator') recordBinding(node);
        const nameNode = node.childForFieldName('name');
        const value = node.type === 'variable_declarator' ? node.childForFieldName('value') : node;
        const name = nameNode?.type === 'identifier' || nameNode?.type === 'property_identifier' ? nameNode.text : undefined;
        const fnLike = !!value && (isFn(value.type) || value.type === 'call_expression' || value.type === 'function_declaration' || value.type === 'method_definition');
        if (name && fnLike) {
          const [line, endLine] = lines(node);
          out.functions.push({ name, line, endLine, calls: collectCalls(value), hasTry: hasTry(value) });
          if (/^[A-Z]/.test(name) && containsJsx(node)) {
            out.components.push({ name, line, endLine, props: isFn(value.type) || value.type === 'function_declaration' ? propNames(value) : [] });
            ctx = { ...ctx, component: name };
          }
        }
        break;
      }
      case 'pair': {
        // `api = { list: () => [] }`: a function stored as an object property.
        const key = node.childForFieldName('key');
        const value = node.childForFieldName('value');
        if (key && value && isFn(value.type) && (key.type === 'property_identifier' || key.type === 'identifier')) {
          const [line, endLine] = lines(node);
          out.functions.push({ name: key.text, line, endLine, calls: collectCalls(value), hasTry: hasTry(value) });
        }
        break;
      }
      case 'call_expression': {
        // `items.map((x) => <li/>)`: everything rendered inside repeats per item.
        const fn = node.childForFieldName('function');
        if (fn?.type === 'member_expression' && fn.childForFieldName('property')?.text === 'map') {
          visit(fn, ctx);
          const args = node.childForFieldName('arguments');
          for (const a of args?.namedChildren ?? []) visit(a, { ...ctx, repeated: true });
          return;
        }
        break;
      }
      case 'binary_expression': {
        const right = node.childForFieldName('right');
        if (node.childForFieldName('operator')?.text === '&&' && isJsx(right)) {
          const left = node.childForFieldName('left')!;
          visit(left, ctx);
          const [line, endLine] = lines(left);
          const cond: UiCondition = { text: clip(left.text), branch: 'and', line, endLine };
          visit(right!, { ...ctx, conditions: [...ctx.conditions, cond], branchRoot: true });
          return;
        }
        break;
      }
      case 'ternary_expression': {
        const test = node.childForFieldName('condition')!;
        const [line, endLine] = lines(test);
        visit(test, ctx);
        for (const [field, branch] of [['consequence', 'then'], ['alternative', 'else']] as const) {
          const side = node.childForFieldName(field);
          if (!side) continue;
          const cond: UiCondition = { text: clip(test.text), branch, line, endLine };
          visit(side, { ...ctx, conditions: [...ctx.conditions, cond], branchRoot: true });
        }
        return;
      }
      case 'jsx_fragment':
        // Transparent: keep the branch-root flag for the fragment's direct elements.
        for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!, ctx);
        return;
      case 'jsx_element':
      case 'jsx_self_closing_element': {
        const tag = tagOf(node);
        if (tag && tag.name !== '') {
          const { events, handlerRefs, refs, inline } = eventsOf(tag);
          const kind = kindOf(tag.name);
          const interactive = kind !== 'element' || events.length > 0;
          // One of the app's own components (not a UI-kit primitive or a library one) rendered here.
          const appImport = out.imports[tag.name];
          const usage = !interactive && /^[A-Z]/.test(tag.name) && !!appImport && /^(\.|@\/|~\/|src\/)/.test(appImport.spec) && !/\/ui\//.test(appImport.spec);
          if (interactive || ctx.branchRoot || usage) {
            const own: Array<[number, number]> = [lines(tag.open)];
            if (node.type === 'jsx_element') {
              const close = node.childForFieldName('close_tag');
              if (close) own.push(lines(close));
              for (let i = 0; i < node.namedChildCount; i++) {
                const c = node.namedChild(i)!;
                if (c.type === 'jsx_text' && c.text.trim()) own.push(lines(c));
                else if (c.type === 'jsx_expression' && !containsJsx(c)) own.push(lines(c));
              }
            }
            out.elements.push({
              tag: tag.name,
              kind,
              label: labelOf(node, tag, kind),
              own,
              events,
              handlerRefs,
              refs,
              inline,
              props: staticProps(tag),
              repeated: ctx.repeated,
              ...(usage ? { usage: true } : {}),
              conditions: ctx.conditions,
              component: ctx.component,
            });
          }
        }
        const innerCtx: Ctx = { ...ctx, branchRoot: false };
        if (node.type === 'jsx_element') for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!, innerCtx);
        else for (const a of tag?.attrs ?? []) visit(a, innerCtx);
        return;
      }
      default:
        break;
    }
    const inner = ctx.branchRoot && node.type !== 'parenthesized_expression' ? { ...ctx, branchRoot: false } : ctx;
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!, inner);
  }

  visit(tree.rootNode, { conditions: [], branchRoot: false, repeated: false });
  return out;
}
