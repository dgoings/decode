import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '@codeviz/core';

export function cacheDir(repoId: string): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'codeviz', repoId);
}

export function readSnapshot(repoId: string, sha: string, toolVersion: string): Snapshot | null {
  try {
    const s = decodeSnapshot(readFileSync(join(cacheDir(repoId), `${sha}.json.gz`)));
    return s.toolVersion === toolVersion ? s : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(snapshot: Snapshot): void {
  const dir = cacheDir(snapshot.repoId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${snapshot.sha}.json.gz`), encodeSnapshot(snapshot));
}

export function listSnapshots(repoId: string): { sha: string; ref: string; analyzedAt: string; toolVersion: string }[] {
  let names: string[];
  try {
    names = readdirSync(cacheDir(repoId)).filter((n) => n.endsWith('.json.gz'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const meta = decodeSnapshot(readFileSync(join(cacheDir(repoId), n)));
      out.push({ sha: meta.sha, ref: meta.ref, analyzedAt: meta.analyzedAt, toolVersion: meta.toolVersion });
    } catch {
      // skip corrupt files
    }
  }
  return out;
}
