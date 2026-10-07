import { extname } from 'node:path';
import type { Adapter } from '../registry.ts';
import { buildFileGraph } from '../imports/graph.ts';
import type { Resolver } from '../imports/resolver.ts';
import { createBaselineTsResolver } from '../imports/ts-baseline.ts';
import { listTrackedFiles, walkRepo } from '../walker/walker.ts';
import { tsLanguages } from '../walker/languages/ts.ts';

const exts = new Set(tsLanguages.flatMap((c) => c.extensions));

/**
 * Resolver seam: the precise (compiler-backed) resolver slots in here. `files` is
 * every tracked file, so non-source targets (CSS, JSON) still resolve.
 */
export function pickResolver(root: string, files: string[]): Resolver {
  return createBaselineTsResolver(root, files);
}

export const tsAdapter: Adapter = {
  name: 'ts',
  detect(root) {
    return listTrackedFiles(root).some((f) => exts.has(extname(f).toLowerCase()));
  },
  async analyze(root, ctx) {
    const tracked = listTrackedFiles(root);
    const walked = await walkRepo(root, tsLanguages, tracked, { imports: true });
    const files = walked.files ?? [];
    const resolver = pickResolver(root, tracked);
    const graph = buildFileGraph(walked.imports ?? [], resolver, files.map((f) => f.path));
    if (graph.unresolved > 0) {
      ctx.log(`ts: ${graph.unresolved} of ${walked.imports?.length ?? 0} import specifiers unresolved (${resolver.tier} resolver)`);
    }
    return {
      files,
      functions: walked.functions ?? [],
      modules: graph.modules,
      edges: graph.edges,
      languages: files.length ? { ts: resolver.tier } : undefined,
    };
  },
};
