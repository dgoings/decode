import { mergeSnapshots } from '@codeviz/core';
import type { Snapshot, SnapshotMeta } from '@codeviz/core';

export interface ResolvedRefLike {
  sha: string;
  ref: string;
}

export interface AnalyzeContext {
  ref: ResolvedRefLike;
  since: string;
  log: (msg: string) => void;
}

export interface Adapter {
  name: string;
  detect(root: string): boolean;
  analyze(root: string, ctx: AnalyzeContext): Promise<Partial<Snapshot>>;
}

const adapters: Adapter[] = [];

export function registerAdapter(a: Adapter): void {
  adapters.push(a);
}

export function listAdapters(): Adapter[] {
  return [...adapters];
}

export function clearAdapters(): void {
  adapters.length = 0;
}

export async function runAdapters(
  root: string,
  ctx: AnalyzeContext,
  meta: SnapshotMeta,
): Promise<{ snapshot: Snapshot; warnings: string[] }> {
  const warnings: string[] = [];
  const matched = adapters.filter((a) => a.detect(root));
  if (matched.length === 0) warnings.push(`no adapter matched ${root}`);
  const parts = await Promise.all(
    matched.map(async (a) => {
      try {
        return await a.analyze(root, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`adapter ${a.name} failed: ${message}`, { cause: err });
      }
    }),
  );
  return { snapshot: mergeSnapshots(meta, parts), warnings };
}
