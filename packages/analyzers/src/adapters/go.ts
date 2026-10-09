import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../registry.ts';
import { createGoResolver } from '../imports/go-resolver.ts';
import { buildPackageGraph } from '../imports/graph.ts';
import { goConfig, listTrackedFiles, walkRepo } from '../walker/index.ts';

// Size, complexity, and package-level imports (module-level edges only).
export const goAdapter: Adapter = {
  name: 'go',
  detect(root) {
    if (existsSync(join(root, 'go.mod'))) return true;
    try {
      return listTrackedFiles(root).some((f) => f.endsWith('.go'));
    } catch {
      return false;
    }
  },
  async analyze(root, ctx) {
    const tracked = listTrackedFiles(root);
    const walked = await walkRepo(root, [goConfig], tracked, { imports: true });
    const files = walked.files ?? [];
    const resolver = createGoResolver(root, tracked);
    const graph = buildPackageGraph(walked.imports ?? [], resolver, files.map((f) => f.path), {
      externalTest: (f) => f.endsWith('_test.go') && goPackageName(join(root, f))?.endsWith('_test') === true,
    });
    if (graph.unresolved > 0) {
      ctx.log(`go: ${graph.unresolved} of ${walked.imports?.length ?? 0} import specifiers unresolved (${resolver.tier} resolver)`);
    }
    return {
      files,
      functions: walked.functions ?? [],
      modules: graph.modules,
      edges: graph.edges,
      languages: files.length ? { go: resolver.tier } : undefined,
    };
  },
};

/** Package clause name of a Go source file (comments stripped), or undefined. */
export function goPackageName(absPath: string): string | undefined {
  try {
    const src = readFileSync(absPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return /^\s*package\s+(\w+)/m.exec(src)?.[1];
  } catch {
    return undefined;
  }
}
