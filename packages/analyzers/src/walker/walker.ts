import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import Parser from 'web-tree-sitter';
import type { FileEntry, FunctionEntry, Snapshot } from '@codeviz/core';
import type { RawImport } from '../imports/resolver.ts';
import type { LanguageConfig } from './config.ts';

const MAX_BYTES = 1024 * 1024;

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Parser.Language>>();
let parser: Parser | undefined;
const queryCache = new Map<string, Parser.Query>();
const IMPORT_KINDS = new Set<RawImport['kind']>(['import', 'export', 'dynamic', 'require']);

function wasmPath(file: string): string {
  const req = createRequire(import.meta.url);
  return join(dirname(req.resolve('tree-sitter-wasms/package.json')), 'out', file);
}

/** Lazily initialise web-tree-sitter and load (once per wasm file) the config's grammar. */
export function loadLanguage(config: LanguageConfig): Promise<Parser.Language> {
  let lang = languageCache.get(config.wasm);
  if (!lang) {
    initPromise ??= Parser.init();
    lang = initPromise.then(() => Parser.Language.load(wasmPath(config.wasm)));
    languageCache.set(config.wasm, lang);
  }
  return lang;
}

/** Run the config's import query over an already-parsed tree. */
function importsFromTree(
  tree: Parser.Tree,
  relPath: string,
  config: LanguageConfig,
  language: Parser.Language,
): RawImport[] {
  if (!config.importQuery) return [];
  const key = `${config.wasm}\0${config.importQuery}`;
  let query = queryCache.get(key);
  if (!query) queryCache.set(key, (query = language.query(config.importQuery)));
  const capName = config.importCaptures?.specifier ?? 'spec';
  const out: RawImport[] = [];
  // `setProperties` (from #set!) exists at runtime but is missing from the 0.24 typings.
  for (const m of query.matches(tree.rootNode) as Array<Parser.QueryMatch & { setProperties?: Record<string, string | null> }>) {
    const cap = m.captures.find((c) => c.name === capName);
    if (!cap) continue;
    const specifier = cap.node.text.replace(/^(['"`])([\s\S]*)\1$/, '$2');
    const tagged = m.setProperties?.kind as RawImport['kind'] | undefined;
    const kind = tagged && IMPORT_KINDS.has(tagged) ? tagged : 'import';
    out.push({ file: relPath, specifier, line: cap.node.startPosition.row + 1, kind });
  }
  return out;
}

function splitLines(src: string): string[] {
  if (src === '') return [];
  const lines = src.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function locOnly(path: string, config: LanguageConfig, src: string | Buffer): FileEntry {
  const text = typeof src === 'string' ? src : src.toString('latin1');
  return { path, lang: config.id, loc: splitLines(text).length };
}

interface FnState {
  entry: FunctionEntry;
}

/** Analyze one source string with an already-loaded grammar. */
function analyzeSource(
  src: string,
  relPath: string,
  config: LanguageConfig,
  language: Parser.Language,
  withImports = false,
): { file: FileEntry; functions: FunctionEntry[]; imports?: RawImport[] } {
  parser ??= new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(src);
  if (!tree) throw new Error('parse failed');

  const fnTypes = new Set(config.functionNodes);
  const branchTypes = new Set(config.branchNodes);
  const commentTypes = new Set(config.commentNodes);
  const elseTypes = new Set(config.elseNodes ?? []);
  const logicalTypes = new Set(config.logicalNodes ?? []);
  const logicalOps = config.logicalOperators ?? [];
  const nameField = config.nameField ?? 'name';

  const functions: FunctionEntry[] = [];
  const commentRanges: Array<[number, number]> = []; // [startIndex, endIndex)
  const commentRows: Array<[number, number]> = []; // [startRow, endRow]

  const nameOf = (node: Parser.SyntaxNode): string => {
    const own = node.childForFieldName(nameField);
    if (own) return own.text;
    const parent = node.parent;
    const field = parent && config.nameFromParent?.[parent.type];
    const fromParent = field ? parent.childForFieldName(field) : null;
    return fromParent ? fromParent.text : '<anonymous>';
  };

  const cursor = tree.walk();
  const visit = (fn: FnState | null, depth: number): void => {
    const type = cursor.nodeType;
    if (commentTypes.has(type)) {
      commentRanges.push([cursor.startIndex, cursor.endIndex]);
      commentRows.push([cursor.startPosition.row, cursor.endPosition.row]);
      return;
    }
    let childFn = fn;
    let childDepth = depth;
    if (fnTypes.has(type)) {
      const node = cursor.currentNode;
      const entry = { file: relPath, name: nameOf(node), line: node.startPosition.row + 1, complexity: 1 };
      functions.push(entry);
      childFn = { entry };
      childDepth = 0;
    } else if (fn && branchTypes.has(type)) {
      if (logicalTypes.has(type)) {
        // Logical operators count once and do not nest.
        const op = cursor.currentNode.childForFieldName('operator');
        if (op && logicalOps.includes(op.type)) fn.entry.complexity += 1;
      } else {
        fn.entry.complexity += 1 + depth;
        childDepth = depth + 1;
      }
    }
    if (!cursor.gotoFirstChild()) return;
    const isElse = elseTypes.has(type);
    do {
      // `else if`: the inner branch sits at the same depth as the outer `if`.
      const d = isElse && branchTypes.has(cursor.nodeType) ? childDepth - 1 : childDepth;
      visit(childFn, d);
    } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  };
  visit(null, 0);
  let imports: RawImport[] | undefined;
  try {
    if (withImports) imports = importsFromTree(tree, relPath, config, language);
  } finally {
    tree.delete();
  }

  // Size: blank lines, lines touched by a comment, and comment-only lines.
  const lines = splitLines(src);
  let masked = '';
  let pos = 0;
  for (const [s, e] of commentRanges) {
    masked += src.slice(pos, s) + src.slice(s, e).replace(/[^\n]/g, ' ');
    pos = e;
  }
  masked += src.slice(pos);
  const maskedLines = masked.split('\n');
  const isCommentRow = new Uint8Array(lines.length);
  for (const [s, e] of commentRows) for (let r = s; r <= e && r < lines.length; r++) isCommentRow[r] = 1;

  let blank = 0;
  let comments = 0;
  let commentOnly = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      blank++;
      continue;
    }
    if (isCommentRow[i]) {
      comments++;
      if (maskedLines[i].trim() === '') commentOnly++;
    }
  }

  const complexities = functions.map((f) => f.complexity);
  const file: FileEntry = {
    path: relPath,
    lang: config.id,
    loc: lines.length,
    code: lines.length - blank - commentOnly,
    comments,
    complexity: {
      sum: complexities.reduce((a, b) => a + b, 0),
      max: complexities.length ? Math.max(...complexities) : 0,
      functions: functions.length,
    },
  };
  return imports ? { file, functions, imports } : { file, functions };
}

/**
 * Analyze one file. Binary, unreadable, or unparseable files fall back to a
 * loc-only record. The grammar must be loadable; it is loaded on first use.
 */
export async function analyzeFile(
  absPath: string,
  relPath: string,
  config: LanguageConfig,
  opts: { imports?: boolean } = {},
): Promise<{ file: FileEntry; functions: FunctionEntry[]; imports?: RawImport[] }> {
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return { file: { path: relPath, lang: config.id, loc: 0 }, functions: [] };
  }
  if (buf.subarray(0, 8000).includes(0)) return { file: locOnly(relPath, config, buf), functions: [] };
  const src = buf.toString('utf8');
  try {
    return analyzeSource(src, relPath, config, await loadLanguage(config), opts.imports);
  } catch {
    return { file: locOnly(relPath, config, src), functions: [] };
  }
}

/** Extract raw imports from one file with the config's import query ([] when it has none). */
export async function extractImports(absPath: string, relPath: string, config: LanguageConfig): Promise<RawImport[]> {
  if (!config.importQuery) return [];
  let src: string;
  try {
    const buf = readFileSync(absPath);
    if (buf.subarray(0, 8000).includes(0)) return [];
    src = buf.toString('utf8');
  } catch {
    return [];
  }
  const language = await loadLanguage(config);
  parser ??= new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(src);
  if (!tree) return [];
  try {
    return importsFromTree(tree, relPath, config, language);
  } finally {
    tree.delete();
  }
}

/** Repo-relative paths of tracked files (respects .gitignore). */
export function listTrackedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

/** Walk the given repo-relative files with whichever configs match their extension. */
export async function walkRepo(
  root: string,
  configs: LanguageConfig[],
  files: string[],
  opts: { imports?: boolean } = {},
): Promise<Partial<Snapshot> & { imports?: RawImport[] }> {
  const byExt = new Map<string, LanguageConfig>();
  for (const c of configs) for (const ext of c.extensions) byExt.set(ext, c);

  const outFiles: FileEntry[] = [];
  const outFunctions: FunctionEntry[] = [];
  const languages: Snapshot['languages'] = {};
  const imports: RawImport[] = [];

  for (const rel of files) {
    const config = byExt.get(extname(rel).toLowerCase());
    if (!config) continue;
    const abs = join(root, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
    } catch {
      continue;
    }
    const res = await analyzeFile(abs, rel, config, opts);
    outFiles.push(res.file);
    for (const f of res.functions) outFunctions.push(f);
    if (res.imports) for (const i of res.imports) imports.push(i);
    languages[config.id] = 'baseline';
  }
  const result = { languages, files: outFiles, functions: outFunctions };
  return opts.imports ? { ...result, imports } : result;
}
