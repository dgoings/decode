// `codeviz trace import-cpuprofile`: Bun (`bun --cpu-prof`) or Chrome .cpuprofile → trace file.
import { readFileSync, statSync } from 'node:fs';
import { createTraceWriter, countsToTuples, edgesToTuples, type TraceHeader, type TraceTick } from './format.ts';
import { bucketProfile, resolveProfileFrames, ScriptMapper, type CpuProfile } from './profile.ts';
import { RepoPaths } from './sourcemap.ts';

export interface ImportResult {
  header: TraceHeader;
  ticks: TraceTick[];
  dropped: number;
  droppedUrls: Map<string, number>;
  warnings: string[];
}

export async function convertCpuProfile(
  profile: CpuProfile,
  opts: { paths: RepoPaths; sha: string; repoId?: string; tickMs: number; startedAt: string },
): Promise<ImportResult> {
  const mapper = new ScriptMapper(opts.paths);
  const fileOf = await resolveProfileFrames(profile, mapper);
  const buckets = bucketProfile(profile, fileOf, opts.tickMs);
  const droppedUrls = new Map<string, number>();
  for (const n of profile.nodes) {
    const url = n.callFrame.url;
    if (url && !fileOf.get(n.id)) droppedUrls.set(url, (droppedUrls.get(url) ?? 0) + (n.hitCount ?? 0));
  }
  const ticks: TraceTick[] = buckets.map((b, i) => ({
    t: i * opts.tickMs,
    files: countsToTuples(b.files),
    edges: edgesToTuples(b.edges),
    dropped: b.dropped,
  }));
  const header: TraceHeader = {
    format: 'codeviz-trace',
    version: 1,
    ...(opts.repoId ? { repoId: opts.repoId } : {}),
    sha: opts.sha,
    startedAt: opts.startedAt,
    tickMs: opts.tickMs,
    source: 'cpuprofile',
  };
  return { header, ticks, dropped: ticks.reduce((s, t) => s + (t.dropped ?? 0), 0), droppedUrls, warnings: mapper.warnings };
}

export async function importCpuProfileFile(
  file: string,
  out: string,
  opts: { paths: RepoPaths; sha: string; repoId?: string; tickMs: number },
): Promise<ImportResult> {
  const profile = JSON.parse(readFileSync(file, 'utf8')) as CpuProfile;
  if (!Array.isArray(profile.nodes)) throw new Error(`${file}: not a .cpuprofile (no nodes)`);
  // Profile clocks are monotonic µs; anchor t=0 to the file's mtime minus the profile duration.
  const durMs = (profile.endTime - profile.startTime) / 1000;
  const startedAt = new Date(statSync(file).mtimeMs - durMs).toISOString();
  const r = await convertCpuProfile(profile, { ...opts, startedAt });
  const w = createTraceWriter(out);
  w.write(r.header);
  for (const t of r.ticks) w.write(t);
  await w.close();
  return r;
}
