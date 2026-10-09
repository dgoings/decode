# codeviz — design

A local CLI run inside any checked-out repo. It analyzes the repo at one or more
commits, caches results, and serves an interactive visualization on localhost:
size, complexity, dependency graph, churn, and comparisons between any two refs.
It can export a static snapshot and publish it as a Particles site.

```
codeviz analyze [ref...]        # default: HEAD; caches per SHA
codeviz serve                   # localhost UI over everything cached; can trigger analyze
codeviz compare <base> <head>   # analyze both if needed, open compare view
codeviz export <dir> [refs...]  # static site + data, ready for `particles deploy`
```

## Principles

- **Nothing added to the analyzed project.** No config files, CI, or dependencies.
  Cache lives in `~/.cache/codeviz/<repo-id>/<sha>.json.gz`. Tool-level settings
  (history window, etc.) are CLI flags with defaults, optionally persisted in
  `~/.config/codeviz/config.json`, never in the repo.
- **Node is the only requirement.** Every language gets a baseline analysis that
  runs with Node alone. The repo's own toolchain adds accuracy when present, never
  required.
- **Never touch the working tree.** Non-HEAD refs are analyzed through a temporary
  `git worktree add --detach`, removed afterwards. Uncommitted changes are the
  pseudo-ref `WORKTREE`.
- **One snapshot format.** Diffing and UI never know the language.

## Decisions (resolved from review — override if you disagree)

- **`<repo-id>`** = SHA of the repo's root commit (`git rev-list --max-parents=0 HEAD`,
  first if several). Works with no remote and survives forks/renames. `origin` URL
  is recorded in the snapshot for display only.
- **`WORKTREE` is never cached.** It's analyzed on demand and held in memory by
  `serve`; `export` refuses it.
- **History window** defaults to 365 days, `--since <duration|date>` overrides.
- **Precise TS on non-HEAD refs:** a detached worktree has no `node_modules`. If
  the HEAD checkout's `node_modules/typescript` exists and the ref's `package.json`
  pins a compatible major, reuse it; otherwise fall back to baseline and record
  `"ts": "baseline"` for that snapshot. The UI shows the tier per ref.
- **Renames in compare:** run `git diff -M --name-status <base> <head>` and apply the
  rename map before diffing snapshots, so a moved file shows as a delta not a
  delete+add.
- **Refs that aren't analyzed yet** appear in the ref picker in a distinct state;
  selecting one triggers `analyze` through the server (`POST /api/analyze`).
- **Graph library: Cytoscape.js** (compound nodes for collapsible directories).
- **Node floor: 20 LTS.** Everything emitted by `bun build --target=node` must run
  there; CI tests under Node 20 and current Bun.
- **Go adapter stub lands in milestone 1**, not 6: size + complexity only, via the
  data-driven walker, to validate the registry before TS gets deep. Milestone 6
  completes it (package-level imports).

## Runtime

TypeScript. Bun is the dev toolchain (package manager, test runner, `bun build`,
`bunx codeviz`). Runtime code uses only `node:*` APIs (`http`, `fs`,
`child_process`, `zlib`); no `Bun.*` or `bun:*` outside dev scripts. Published to
npm as one bundled ESM file plus embedded UI assets and lazily-loaded tree-sitter
`.wasm` grammars. Standalone binaries via `bun build --compile` are a later option.

## Analysis layers

| Layer | Approach | Requires |
|---|---|---|
| Size | line/blank/comment counts from tree-sitter comment nodes; plain-text fallback | Node |
| Complexity | cyclomatic + nesting per function from tree-sitter branch nodes | Node |
| Imports (baseline) | tree-sitter query extraction, per-language resolver | Node |
| History | `git log --numstat` over the window: churn, authors, change coupling | git |
| Imports (precise) | repo's own toolchain when present | toolchain |
| Symbols/calls (later) | SCIP indexers, one schema for every language | toolchain |

Parsing uses `web-tree-sitter` (wasm, no native modules). Grammars exist for
TS/TSX, JS, Go, Rust, Java, Kotlin, C#. Only TS/JS is built for real; Go proves
the second-language seam; nothing is built up front for the rest.

## Extensibility seams (day one)

1. **Adapter registry.** `detect(root): boolean`, `analyze(root, ctx): Promise<Partial<Snapshot>>`.
   All matching adapters run and merge, so polyglot repos work.
2. **Data-driven tree-sitter baseline.** One generic walker configured per
   language: function/branch/comment node types plus an import query. A new
   language's baseline = config object + `.wasm` + resolver.
3. **Resolvers separate from extraction.** Extraction is a query; resolution is a
   per-language function returning file | module | external.
4. **Schema allows coarse graphs.** `modules[].kind` (`dir|package|namespace|crate`)
   and `edges[].level` (`file|module`). Graph and compare views must render with
   module-level edges only. The Go adapter exercises this.
5. **Accuracy recorded per language** in `languages: { ts: "precise", go: "baseline" }`,
   shown in the UI.

## Snapshot format (the contract)

```jsonc
{
  "repo": "capacitor", "repoId": "<root sha>", "origin": "…", "sha": "…", "ref": "main",
  "analyzedAt": "…", "toolVersion": "0.1.0",
  "languages": { "ts": "precise" },
  "files": [ { "path": "src/app.ts", "lang": "ts", "loc": 120, "code": 98, "comments": 9,
               "complexity": { "sum": 14, "max": 6, "functions": 5 },
               "churn": { "commits": 7, "authors": 2 } } ],
  "functions": [ { "file": "…", "name": "…", "line": 10, "complexity": 6 } ],
  "modules":   [ { "id": "src/store", "kind": "dir", "files": ["…"] } ],
  "edges":     [ { "from": "…", "to": "…", "kind": "import", "level": "file" } ],
  "coupling":  [ { "a": "…", "b": "…", "coChanges": 9 } ]
}
```

Cache key is SHA + `toolVersion`; an analyzer upgrade invalidates the cache.

## UI (Vite + TypeScript)

Ref picker (cached SHAs, branches, tags; unanalyzed state) → treemap (area = code
lines, color = complexity | churn) → dependency graph (Cytoscape, collapsible
dirs, cycles highlighted) → compare (treemap by delta, added/removed edges, table
of biggest changes). `serve` exposes `/api/snapshots`, `/api/snapshots/:sha`,
`/api/compare`, `/api/analyze`. `export` builds the same UI reading static JSON;
one code path, two data sources.

### Overlays

External per-file numbers (coverage, bundle bytes, error counts) attach as extra
color modes without a feature per source. An overlay is JSON
`{ "name": "coverage", "unit": "%", "higherIsBetter": true, "min": 0, "max": 100, "rows": [["src/a.ts", 83.2]] }`
(only `rows` is required; `name` defaults to the file's basename) or CSV with a
`path,value` header (named after the basename). `serve --overlay <file>` and
`export --overlay <file>` (repeatable) load them; paths are normalized like walker
paths (forward slashes, no leading `./`, absolute paths under the repo root made
relative) and rows that match no file in HEAD (serve) or the first exported ref
(export) are counted once on stderr. Overlays are inputs, never cached:
`GET /api/overlays` lists `{name, unit, higherIsBetter, min, max, rows: n}`,
`GET /api/overlays/:name` returns the overlay; export writes
`snapshots/overlays/index.json` and `<name>.json.gz`. The UI adds one
`overlay:<name>` mode per overlay (hash `mode=overlay:coverage`) to the treemap,
graph and map; files without a value are neutral, and when `higherIsBetter` the
red ramp is flipped so the bad end is always dark. `codeviz overlay lcov
<lcov.info> [--out f] [--root dir]` is the reference converter (line coverage %).

### Runtime traces in the UI

`serve --trace <file>` (repeatable) and `export --trace <file>` load recorded
traces (format: `docs/trace-format.md`); they are kept in memory, never cached.
`serve --trace-listen` also accepts live ticks as `POST /trace` (the body the Bun
preload posts: a header line plus tick lines); `--trace-port <n>` adds a second
listener on that port that takes a POST on any path, so `--trace-port 7357`
matches the preload's default `CODEVIZ_TRACE_URL`. A POST with an `Origin` header
from another origin is refused. Each traced process (source + startedAt + sha)
becomes one live trace.

- `GET /api/traces` -> `[{id, source, sha, repoId?, startedAt, tickMs, ticks, durationMs, live}]`
  (`ticks` is the count, `durationMs` the last tick's `t`; ids come from the file name, or
  `live-<source>-<HHMMSS>`).
- `GET /api/traces/:id` -> `{header, ticks}` (gzip when accepted).
- `GET /api/traces/:id/stream?from=<n>` -> `text/event-stream`, one `data: <tick JSON>` event
  per tick from index `n`, then each new tick of a live trace (a recorded trace's stream ends).
- Export writes `snapshots/traces/index.json` (same list, `live: false`) and `<id>.json.gz`.

The Graph and Map views show a Trace strip when any trace exists: trace picker,
play/pause, speed (0.5x-4x), scrubber, Follow (live traces), decay (how long a
call stays lit) and Summary. Hash: `trace=<id>` (or `trace=<n>`, the n-th trace),
`t=<ms>`, `summary=1`. Playback is a reducer over ticks (`web/src/trace/model.ts`):
per-file and per-edge heat, incremented by tick counts and decayed exponentially
per animation frame (about 5% left after the decay time); a jump (scrub, hidden
tab) recomputes heat from the ticks within four decay windows. Heat is drawn on a
canvas over the Cytoscape canvas in its pan/zoom transform (restyling Cytoscape
elements per frame is too slow on compound graphs): lit nodes, pulsing import edges
in orange, and runtime calls with no import edge in that direction as dashed purple
curves. Collapsed groups sum their files. Summary freezes playback, restyles the
graph once (import edges that carried calls, ones that never did, runtime-only edges
as real edges) with counts over the file-level import graph, and registers the
`executed` overlay (total calls per file), which also shows on the treemap. A trace
whose sha differs from the shown snapshot gets a warning in the strip.

## Repo layout

```
packages/
  core/       snapshot types, merge, diff, rename map
  analyzers/  tree-sitter walker, git history, adapters (ts, go)
  cli/        commands, server, export
  web/        Vite UI
```

Bun workspace, published as a single `codeviz` npm package.

## Publishing to Particles (later)

`codeviz export out/ main feature-x` then `particles deploy out --name <site>`.
Data folder is `snapshots/`, not `data/` (Particles skips `data/`). Deploy is one
POST of base64 files, so gzip snapshots and include only chosen refs. A published
site is visible to everyone at AO, so publishing is explicit, with a confirmation
prompt that names the repo.

## Milestones

| # | Milestone | Outcome |
|---|---|---|
| M0 | Scaffold | Bun workspace, `bun build --target=node`, CI (Bun + Node 20), core snapshot types + merge |
| M1 | Baseline snapshot for Capacitor | repo identity, cache, worktree lifecycle, adapter registry, tree-sitter walker (TS + Go stub), git history, `codeviz analyze` |
| M2 | Serve + treemap | `codeviz serve`, UI shell with ref picker, D3 treemap |
| M3 | TS import graph | baseline + precise TS resolvers, file-level edges |
| M4 | Dependency graph view | Cytoscape compound graph, cycles, module-level-only rendering |
| M5 | Compare | core diff with rename map, `codeviz compare`, compare view |
| M6 | Go adapter complete | Go imports, package-level resolver, module-level edges |
| M7 | Export + Particles | `codeviz export`, publish flow |
