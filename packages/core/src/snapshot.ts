export type LanguageTier = 'precise' | 'baseline';
export type ModuleKind = 'dir' | 'package' | 'namespace' | 'crate';
export type EdgeLevel = 'file' | 'module';

export interface FileEntry {
  path: string;
  lang?: string;
  loc?: number;
  code?: number;
  comments?: number;
  complexity?: { sum: number; max: number; functions: number };
  churn?: { commits: number; authors: number };
}

export interface FunctionEntry {
  file: string;
  name: string;
  line: number;
  complexity: number;
}

export interface ModuleEntry {
  id: string;
  kind: ModuleKind;
  files: string[];
}

export interface EdgeEntry {
  from: string;
  to: string;
  kind: string;
  level: EdgeLevel;
}

export interface CouplingEntry {
  a: string;
  b: string;
  coChanges: number;
}

export interface Snapshot {
  repo: string;
  repoId: string;
  origin: string;
  sha: string;
  ref: string;
  analyzedAt: string;
  toolVersion: string;
  /** History window (--since) the snapshot was built with. */
  since?: string;
  languages: Record<string, LanguageTier>;
  files: FileEntry[];
  functions: FunctionEntry[];
  modules: ModuleEntry[];
  edges: EdgeEntry[];
  coupling: CouplingEntry[];
}

export type SnapshotMeta = Pick<
  Snapshot,
  'repo' | 'repoId' | 'origin' | 'sha' | 'ref' | 'analyzedAt' | 'toolVersion' | 'since'
>;

/**
 * Whether a snapshot's ref label is a human-readable name (a branch or tag) rather than
 * HEAD, a revision expression, or (a prefix of) its own sha.
 */
export function isNamedRef(ref: string, sha: string): boolean {
  return ref !== '' && ref !== 'HEAD' && !/[~^@]/.test(ref) && !sha.startsWith(ref);
}
