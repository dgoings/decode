# Runtime trace format (`codeviz-trace` v1)

Written by `codeviz trace browser | import-cpuprofile | collect`. TypeScript types:
`packages/cli/src/trace/format.ts` (`TraceHeader`, `TraceTick`, `readTrace`, `parseTrace`).

JSON lines, gzip-compressed when the file name ends in `.gz`.

Line 1, header:

```json
{"format":"codeviz-trace","version":1,"repoId":"<root commit>","sha":"<HEAD>","startedAt":"2026-10-09T16:14:10.595Z","tickMs":500,"source":"browser"}
```

- `source`: `browser` (CDP precise coverage + sampling profiler), `server` (Bun preload `harness/bun-trace.ts`), `cpuprofile` (imported `.cpuprofile`).
- `sha`: `git rev-parse HEAD` in `--root` (default cwd), or `--sha` / `CODEVIZ_TRACE_SHA`. `repoId` matches the snapshot's `repoId` and is omitted when unknown.

Every following line is one tick:

```json
{"t":1002,"files":[["src/pages/makers.tsx",5]],"edges":[["src/pages/makers.tsx","src/hooks/useData.ts",12]],"functions":[["src/pages/makers.tsx","renderMakers",5]],"dropped":3}
```

- `t`: ms since `startedAt`. Ticks are deltas, not cumulative. `server` traces skip empty ticks; the others write every tick.
- `files`: `[path, n]`. Paths are repo-relative with forward slashes and limited to files `git ls-files` lists in the root, so they match the snapshot's `files[].path` for the same SHA.
- `edges`: `[from, to, n]`, meaning `from` called into `to`, and only between two different repo files.
- `functions` (optional): `[path, name, n]`. Names come from the runtime, so bundlers may rename them (for example `useSettings2`).
- `dropped` (optional): calls or samples attributed to code outside the repo (node_modules, bundler runtime, data:/eval scripts). The CLI also prints the top dropped sources when it finishes.

What `n` means for each source:

| source | `files` | `edges` |
|---|---|---|
| browser | function invocations (precise coverage call counts) | profiler samples where the two frames are adjacent on the stack |
| server | wrapped-function calls + 1 per module load | sampled caller→callee calls (1 in N, multiplied by N) |
| cpuprofile | samples with the file anywhere on the stack | samples where the two frames are adjacent on the stack |
