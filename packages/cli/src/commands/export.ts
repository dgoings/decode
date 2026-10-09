import { DEFAULT_SINCE, parseSince } from '@codeviz/analyzers';
import { exportSite, MAX_COMPARE_REFS } from '../export.ts';

export const exportUsage =
  'codeviz export <dir> [ref...] [--since <90d|6m|1y|YYYY-MM-DD>] [--force] [--overwrite] [--web-dir <path>] [--overlay <file>]... [--trace <file>]...';

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function exportCommand(args: string[]): Promise<number> {
  const positional: string[] = [];
  let since = DEFAULT_SINCE;
  let force = false;
  let overwrite = false;
  let webDir: string | undefined;
  const overlays: string[] = [];
  const traces: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--force') force = true;
    else if (a === '--overwrite') overwrite = true;
    else if (a === '--since' || a.startsWith('--since=')) {
      const v = a === '--since' ? args[++i] : a.slice('--since='.length);
      if (!v) return fail('--since needs a value');
      since = v;
    } else if (a === '--web-dir' || a.startsWith('--web-dir=')) {
      const v = a === '--web-dir' ? args[++i] : a.slice('--web-dir='.length);
      if (!v) return fail('--web-dir needs a value');
      webDir = v;
    } else if (a === '--overlay' || a.startsWith('--overlay=')) {
      const v = a === '--overlay' ? args[++i] : a.slice('--overlay='.length);
      if (!v) return fail('--overlay needs a file');
      overlays.push(v);
    } else if (a === '--trace' || a.startsWith('--trace=')) {
      const v = a === '--trace' ? args[++i] : a.slice('--trace='.length);
      if (!v) return fail('--trace needs a file');
      traces.push(v);
    } else if (a.startsWith('-')) return fail(`unknown option ${a}\nusage: ${exportUsage}`, 2);
    else positional.push(a);
  }
  const [dir, ...refs] = positional;
  if (!dir) return fail(`expected <dir>\nusage: ${exportUsage}`, 2);
  try {
    parseSince(since);
  } catch (err) {
    return fail((err as Error).message);
  }

  const log = (s: string) => console.error(s);
  try {
    const r = await exportSite({ root: process.cwd(), dir, refs, since, force, overwrite, webDir, overlays, traces, log });
    if (r.pairsSkipped) {
      log(`note: ${r.snapshots.length} refs exceed ${MAX_COMPARE_REFS}; compare files were not precomputed (compare view unavailable)`);
    }
    console.log(
      `codeviz export: ${r.dir}  ${r.snapshots.length} snapshot(s) [${r.snapshots
        .map((s) => `${s.ref} ${s.sha.slice(0, 7)}`)
        .join(', ')}], ${r.pairs} compare file(s), ${size(r.bytes)}`,
    );
    return 0;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function fail(msg: string, code = 1): number {
  console.error(`codeviz export: ${msg}`);
  return code;
}
