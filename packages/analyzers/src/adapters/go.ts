import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../registry.ts';
import { goConfig, listTrackedFiles, walkRepo } from '../walker/index.ts';

// Size and complexity only; import extraction for Go lands in milestone 6.
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
  analyze(root) {
    return walkRepo(root, [goConfig], listTrackedFiles(root));
  },
};
