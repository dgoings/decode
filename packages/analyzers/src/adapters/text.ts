import { readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { FileEntry } from '@codeviz/core';
import type { Adapter } from '../registry.ts';
import { goConfig, listTrackedFiles, splitLines, tsLanguages } from '../walker/index.ts';

const MAX_BYTES = 1024 * 1024;

const claimed = new Set([...tsLanguages, goConfig].flatMap((c) => c.extensions));
const DENY_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'go.sum', 'Cargo.lock', 'Gemfile.lock',
]);
const DENY_SUFFIXES = ['.min.js', '.min.css', '.map'];

/** True when no grammar adapter claims the path and it is not a denylisted generated file. */
export function isTextCandidate(path: string): boolean {
  const name = basename(path);
  if (claimed.has(extname(name).toLowerCase())) return false;
  if (DENY_NAMES.has(name)) return false;
  const lower = name.toLowerCase();
  return !DENY_SUFFIXES.some((s) => lower.endsWith(s));
}

/** Size-only baseline for every tracked file no grammar adapter handles. */
export const textAdapter: Adapter = {
  name: 'text',
  detect: () => true,
  async analyze(root) {
    const files: FileEntry[] = [];
    for (const path of listTrackedFiles(root).filter(isTextCandidate)) {
      const abs = join(root, path);
      let buf: Buffer;
      try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = splitLines(buf.toString('utf8'));
      const ext = extname(path).slice(1).toLowerCase();
      files.push({
        path,
        lang: ext || 'text',
        loc: lines.length,
        code: lines.filter((l) => l.trim() !== '').length,
      });
    }
    return { files };
  },
};
