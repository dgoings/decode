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

// All three share the language id 'ts'; only the grammar differs by extension.
export const tsConfig: LanguageConfig = {
  ...base,
  extensions: ['.ts', '.mts', '.cts'],
  wasm: 'tree-sitter-typescript.wasm',
};

export const tsxConfig: LanguageConfig = {
  ...base,
  extensions: ['.tsx', '.jsx'],
  wasm: 'tree-sitter-tsx.wasm',
};

export const jsConfig: LanguageConfig = {
  ...base,
  extensions: ['.js', '.mjs', '.cjs'],
  wasm: 'tree-sitter-javascript.wasm',
};

export const tsLanguages: LanguageConfig[] = [tsConfig, tsxConfig, jsConfig];
