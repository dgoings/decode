export interface RawImport { file: string; specifier: string; line: number; kind: 'import' | 'export' | 'dynamic' | 'require' }
export type Resolution = { kind: 'file'; path: string } | { kind: 'module'; id: string } | { kind: 'external'; name: string } | { kind: 'unresolved' }
export interface Resolver { resolve(fromFile: string, specifier: string): Resolution; tier: 'precise' | 'baseline' }
