import { extname } from 'node:path';
import type { Adapter } from '../registry.ts';
import { listTrackedFiles, walkRepo } from '../walker/walker.ts';
import { tsLanguages } from '../walker/languages/ts.ts';

const exts = new Set(tsLanguages.flatMap((c) => c.extensions));

export const tsAdapter: Adapter = {
  name: 'ts',
  detect(root) {
    return listTrackedFiles(root).some((f) => exts.has(extname(f).toLowerCase()));
  },
  analyze(root) {
    return walkRepo(root, tsLanguages, listTrackedFiles(root));
  },
};
