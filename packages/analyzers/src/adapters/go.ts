import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../registry.ts';
import { createGoResolver, isGoIgnoredPath } from '../imports/go-resolver.ts';
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
    // Packages and edges only cover files the go tool builds: not vendor/testdata/_x/.x
    // directories, not `//go:build ignore` files. Size records keep every walked file.
    const headers = new Map<string, GoHeader>();
    for (const f of files) if (!isGoIgnoredPath(f.path)) headers.set(f.path, goHeader(join(root, f.path)));
    const pkgFiles = [...headers].filter(([, h]) => !h.ignore).map(([f]) => f);
    const inPkg = new Set(pkgFiles);
    const imports = (walked.imports ?? []).filter((i) => inPkg.has(i.file));
    const graph = buildPackageGraph(imports, resolver, pkgFiles, {
      externalTest: (f) => f.endsWith('_test.go') && headers.get(f)?.pkg?.endsWith('_test') === true,
    });
    if (graph.unresolved > 0) {
      ctx.log(`go: ${graph.unresolved} of ${imports.length} import specifiers unresolved (${resolver.tier} resolver)`);
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

export interface GoHeader {
  /** Package clause name, if found. */
  pkg?: string;
  /** Header carries `//go:build ignore` or `// +build ignore` (other constraints are not evaluated). */
  ignore: boolean;
}

/** Package name and `ignore` build tag of a Go source file, from the text before its package clause. */
export function goHeader(absPath: string): GoHeader {
  let src: string;
  try {
    src = readFileSync(absPath, 'utf8');
  } catch {
    return { ignore: false };
  }
  const m = /^[ \t]*package\s+(\w+)/m.exec(src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, (c) => ' '.repeat(c.length)));
  // Comments were blanked to equal length, so m.index lines up with src.
  const header = m ? src.slice(0, m.index) : src;
  const ignore = /^\/\/go:build\s+ignore\s*$/m.test(header) || /^\/\/\s*\+build\s+ignore\s*$/m.test(header);
  return { pkg: m?.[1], ignore };
}
