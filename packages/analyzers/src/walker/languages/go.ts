import type { LanguageConfig } from '../config.ts';

export const goConfig: LanguageConfig = {
  id: 'go',
  extensions: ['.go'],
  wasm: 'tree-sitter-go.wasm',
  functionNodes: ['function_declaration', 'method_declaration', 'func_literal'],
  // default_case is deliberately not counted.
  branchNodes: [
    'if_statement',
    'for_statement',
    'expression_case',
    'type_case',
    'communication_case',
    'binary_expression',
  ],
  commentNodes: ['comment'],
  nameField: 'name',
  nameFromParent: {
    var_spec: 'name',
    short_var_declaration: 'left',
  },
  logicalNodes: ['binary_expression'],
  logicalOperators: ['&&', '||'],
};
