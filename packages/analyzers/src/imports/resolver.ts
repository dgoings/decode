// Shared import-resolution contract. Extraction (a tree-sitter query) produces
// RawImports; a per-language Resolver maps each specifier to a target.
// All paths are repo-relative with forward slashes.

export interface RawImport {
  file: string;
  specifier: string;
  line: number;
  kind: 'import' | 'export' | 'dynamic' | 'require';
}

export type Resolution =
  | { kind: 'file'; path: string }
  | { kind: 'module'; id: string }
  | { kind: 'external'; name: string }
  | { kind: 'unresolved' };

export interface Resolver {
  resolve(fromFile: string, specifier: string): Resolution;
  tier: 'precise' | 'baseline';
}
