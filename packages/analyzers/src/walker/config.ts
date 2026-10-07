// Plain-data description of a language for the generic tree-sitter walker.
export interface LanguageConfig {
  /** Language id recorded in Snapshot.languages and FileEntry.lang. */
  id: string;
  /** File extensions (with leading dot) this config handles. */
  extensions: string[];
  /** Grammar file name inside tree-sitter-wasms/out/. */
  wasm: string;
  /** Node types that start a new function scope. */
  functionNodes: string[];
  /** Node types that add one to cyclomatic complexity. */
  branchNodes: string[];
  /** Node types that are comments. */
  commentNodes: string[];
  /** Field holding a function's name (default 'name'). */
  nameField?: string;
  /** For unnamed functions: parent node type -> field on the parent holding the name. */
  nameFromParent?: Record<string, string>;
  /**
   * Branch nodes (e.g. binary_expression) that only count when their `operator`
   * field is one of `logicalOperators`. They never add nesting depth.
   */
  logicalNodes?: string[];
  logicalOperators?: string[];
  /** Node types (e.g. else_clause) whose direct child branch stays at the parent's depth (else-if). */
  elseNodes?: string[];
  /**
   * Tree-sitter S-expression query that finds import specifiers. Each match must
   * capture the specifier's string literal under `importCaptures.specifier`; a
   * `(#set! kind "import"|"export"|"dynamic"|"require")` predicate tags the match
   * (default "import").
   */
  importQuery?: string;
  importCaptures?: { specifier: string };
}
