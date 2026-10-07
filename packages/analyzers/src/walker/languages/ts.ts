import type { LanguageConfig } from '../config.ts';

const base = {
  id: 'ts',
  functionNodes: [
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'generator_function_declaration',
    'generator_function',
  ],
  branchNodes: [
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_case',
    'catch_clause',
    'ternary_expression',
    'binary_expression',
  ],
  commentNodes: ['comment'],
  nameField: 'name',
  nameFromParent: {
    variable_declarator: 'name',
    pair: 'key',
    public_field_definition: 'name',
    assignment_expression: 'left',
  },
  logicalNodes: ['binary_expression'],
  logicalOperators: ['&&', '||', '??'],
  elseNodes: ['else_clause'],
};

// Import specifiers: static import, export-from, dynamic import(), require().
// Each match captures the string literal as @spec and tags its kind via #set!.
const JS_IMPORT_QUERY = `
(import_statement source: (string) @spec (#set! kind "import"))
(export_statement source: (string) @spec (#set! kind "export"))
(call_expression function: (import) arguments: (arguments . (string) @spec) (#set! kind "dynamic"))
(call_expression
  function: (identifier) @_fn
  arguments: (arguments . (string) @spec)
  (#eq? @_fn "require")
  (#set! kind "require"))
`;
// TypeScript grammars add `import x = require('...')`; the javascript grammar lacks this node.
const TS_IMPORT_QUERY = `${JS_IMPORT_QUERY}
(import_require_clause source: (string) @spec (#set! kind "require"))
`;
const importCaptures = { specifier: 'spec' };

// All three share the language id 'ts'; only the grammar differs by extension.
export const tsConfig: LanguageConfig = {
  ...base,
  extensions: ['.ts', '.mts', '.cts'],
  wasm: 'tree-sitter-typescript.wasm',
  importQuery: TS_IMPORT_QUERY,
  importCaptures,
};

export const tsxConfig: LanguageConfig = {
  ...base,
  extensions: ['.tsx', '.jsx'],
  wasm: 'tree-sitter-tsx.wasm',
  importQuery: TS_IMPORT_QUERY,
  importCaptures,
};

export const jsConfig: LanguageConfig = {
  ...base,
  extensions: ['.js', '.mjs', '.cjs'],
  wasm: 'tree-sitter-javascript.wasm',
  importQuery: JS_IMPORT_QUERY,
  importCaptures,
};

export const tsLanguages: LanguageConfig[] = [tsConfig, tsxConfig, jsConfig];
